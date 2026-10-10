/**
 * Outgoing email via Nodemailer.
 *
 * With MAIL_USER/MAIL_PASS set it sends through Gmail SMTP (use a Google
 * "App password", not the account password). Without them - e.g. during local
 * development - messages are only logged so nothing breaks.
 */
import nodemailer from "nodemailer";
import { env } from "../config/env.js";

const hasSmtpCredentials = Boolean(env.mail.user && env.mail.pass);

const transporter = hasSmtpCredentials
  ? nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: env.mail.user, pass: env.mail.pass },
      // Re-use connections when sending a batch of meeting links.
      pool: true,
      maxConnections: 3,
    })
  : nodemailer.createTransport({ jsonTransport: true });

/**
 * Sends one email. Resolves when the provider accepted it and rejects on
 * failure, so callers can record whether delivery actually happened.
 *
 * @param {{ to: string, subject: string, html: string }} message
 */
export async function sendMail({ to, subject, html }) {
  const info = await transporter.sendMail({
    from: env.mail.from ? `IEEE-VIT Enrollments <${env.mail.from}>` : undefined,
    to,
    subject,
    html,
  });
  if (!hasSmtpCredentials && !env.isTest) {
    console.log(`[mail:dev] would send "${subject}" to ${to}`);
  }
  return info;
}

/**
 * Fire-and-forget variant for non-critical notifications (task assigned,
 * booking confirmed). Failures are logged and never break the request.
 */
export function sendMailInBackground(message) {
  sendMail(message).catch((err) => {
    console.error(`[mail] failed to send "${message.subject}" to ${message.to}:`, err.message);
  });
}
