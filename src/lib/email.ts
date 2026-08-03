import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Outbound email (invites, OTP codes, recovery links) over plain SMTP —
 * point SMTP_* at any provider (the Hostinger mailbox SMTP works fine).
 *
 * Without SMTP_HOST: in development the message is printed to the server
 * console (so flows stay testable); in production sending fails loudly so
 * misconfiguration can't silently eat invitations.
 */

declare global {
  var __pmMailer: Transporter | undefined;
}

function getTransport(): Transporter | null {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  if (!globalThis.__pmMailer) {
    const port = Number(process.env.SMTP_PORT ?? 587);
    globalThis.__pmMailer = nodemailer.createTransport({
      host,
      port,
      secure: process.env.SMTP_SECURE === '1' || port === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
  }
  return globalThis.__pmMailer;
}

export async function sendEmail(message: {
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  const transport = getTransport();
  if (!transport) {
    if (process.env.NODE_ENV !== 'production' || process.env.EMAIL_DEV_LOG === '1') {
      console.log(
        `[email dev-log] to=${message.to} subject=${message.subject}\n${message.text}`
      );
      return;
    }
    throw new Error('SMTP is not configured (set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS).');
  }
  await transport.sendMail({
    from: process.env.EMAIL_FROM ?? 'SolarFlow AI <no-reply@localhost>',
    ...message,
  });
}
