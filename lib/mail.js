/**
 * Outgoing email.
 *
 * - GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN set: sends through the Gmail API over
 *   HTTPS (port 443). Use this on Render's free plan, which blocks outbound
 *   SMTP (ports 25/465/587). Get a refresh token with `npm run gmail:token`.
 * - Else MAIL_USER/MAIL_PASS set: Gmail SMTP via Nodemailer (use a Google
 *   "App password"). Fine locally, times out on Render free.
 * - Neither: messages are only logged so local development never breaks.
 */
import nodemailer from "nodemailer";
import { env } from "../config/env.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const SENDER_NAME = "IEEE-VIT Enrollments";

const { gmailClientId, gmailClientSecret, gmailRefreshToken } = env.mail;
const useGmailApi = Boolean(gmailClientId && gmailClientSecret && gmailRefreshToken);
const hasSmtpCredentials = !useGmailApi && Boolean(env.mail.user && env.mail.pass);

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
  if (useGmailApi) return sendViaGmailApi({ to, subject, html });

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

// Builds the RFC 822 message with Nodemailer (no network involved).
const composer = nodemailer.createTransport({ streamTransport: true, buffer: true });

let cachedToken = null; // { value, expiresAt }

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: gmailClientId,
      client_secret: gmailClientSecret,
      refresh_token: gmailRefreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Gmail token refresh failed (${res.status}): ${data.error_description || data.error || "unknown"}`);
  }
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

async function sendViaGmailApi({ to, subject, html }) {
  const { message } = await composer.sendMail({
    from: `${SENDER_NAME} <${env.mail.from || env.mail.user}>`,
    to,
    subject,
    html,
  });
  const res = await fetch(SEND_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await getAccessToken()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ raw: message.toString("base64url") }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    if (res.status === 401) cachedToken = null;
    const detail = await res.text().catch(() => "");
    throw new Error(`Gmail API ${res.status}: ${detail.slice(0, 300)}`);
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
