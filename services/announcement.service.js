/**
 * Announcement emails.
 *
 * When an admin posts a new announcement (the banner every candidate sees),
 * it is also emailed to every candidate. Mails go out one at a time so a big
 * batch stays within Gmail API rate limits; failures are logged and skipped.
 */
import { env } from "../config/env.js";
import { db, schema } from "../db/index.js";
import { announcementEmail } from "../lib/emailTemplates.js";
import { sendMail } from "../lib/mail.js";

const { users } = schema;

/**
 * Emails `message` to every candidate.
 * @returns {{ sent: number, failed: number }}
 */
export async function emailAnnouncement(message) {
  const recipients = await db.select({ email: users.email, name: users.name }).from(users);
  const result = { sent: 0, failed: 0 };
  for (const user of recipients) {
    try {
      await sendMail({ to: user.email, ...announcementEmail({ name: user.name, message, appUrl: env.appUrl }) });
      result.sent += 1;
    } catch (err) {
      console.error(`[announcement] failed for ${user.email}:`, err.message);
      result.failed += 1;
    }
  }
  if (!env.isTest) console.log("[announcement]", JSON.stringify(result));
  return result;
}

/** Fire-and-forget variant so saving settings doesn't wait for the whole batch. */
export function emailAnnouncementInBackground(message) {
  emailAnnouncement(message).catch((err) => {
    console.error("[announcement] batch failed:", err.message);
  });
}
