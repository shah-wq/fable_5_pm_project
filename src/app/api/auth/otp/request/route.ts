import { NextResponse } from 'next/server';
import { withAnon } from '@/lib/db';
import { sendEmail } from '@/lib/email';

/**
 * Customer OTP, step 1. Always answers 200 with the same body — whether the
 * account exists is not disclosed. Codes are only ever issued for active
 * customer profiles (enforced in auth.request_otp).
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { email?: string } | null;
  const email = body?.email?.trim();
  if (!email) {
    return NextResponse.json({ error: 'email is required' }, { status: 400 });
  }

  const { rows } = await withAnon((c) =>
    c.query<{ code: string }>('select * from auth.request_otp($1)', [email])
  );

  if (rows[0]?.code) {
    try {
      await sendEmail({
        to: email,
        subject: 'Your SolarFlow sign-in code',
        text: `Your sign-in code is: ${rows[0].code}\n\nIt expires in 10 minutes. If you didn't request this, you can ignore this email.`,
      });
    } catch (error) {
      console.error('otp email failed:', error);
      return NextResponse.json(
        { error: 'We could not send the email. Try again shortly.' },
        { status: 502 }
      );
    }
  }

  return NextResponse.json({ ok: true });
}
