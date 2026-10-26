/**
 * Outgoing email.
 *
 * - BREVO_API_KEY set: sends through Brevo's HTTPS API. Use this on Render's
 *   free plan, which blocks outbound SMTP (ports 25/465/587).
 * - Else MAIL_USER/MAIL_PASS set: sends through Gmail SMTP with Nodemailer
 *   (use a Google "App password"). Fine locally, times out on Render free.
 * - Neither: messages are only logged so local development never breaks.
 */
import nodemailer from "nodemailer";
import { env } from "../config/env.js";

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const SENDER_NAME = "IEEE-VIT Enrollments";

const useBrevo = Boolean(env.mail.brevoApiKey);
const hasSmtpCredentials = !useBrevo && Boolean(env.mail.user && env.mail.pass);

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
  if (useBrevo) return sendViaBrevo({ to, subject, html });

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

async function sendViaBrevo({ to, subject, html }) {
  const senderEmail = env.mail.from || env.mail.user;
  if (!senderEmail) throw new Error("Set MAIL_FROM to a sender verified in Brevo");

  const res = await fetch(BREVO_URL, {
    method: "POST",
    headers: {
      "api-key": env.mail.brevoApiKey,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: { name: SENDER_NAME, email: senderEmail },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Brevo ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
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
