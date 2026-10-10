/**
 * Meeting-link dispatcher.
 *
 * Emails every booked candidate their meeting link once their slot is within
 * `meetingLinkLeadMinutes` (default 30) of starting. It is idempotent: each
 * candidate is "claimed" atomically via `meeting_link_sent_at` before the
 * email goes out, so running it from several places at once (internal
 * scheduler + Render cron + manual trigger) never sends duplicates. Failed
 * sends are un-claimed and retried on the next run.
 */
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { env } from "../config/env.js";
import { db, schema } from "../db/index.js";
import { meetingLinkEmail } from "../lib/emailTemplates.js";
import { sendMail } from "../lib/mail.js";
import { MINUTE } from "../lib/time.js";
import { slotEnd } from "./candidate.service.js";
import { getSettings } from "./settings.service.js";

const { users, slots } = schema;
const MAX_SLOT_DURATION_MINUTES = 240; // matches the slots CHECK constraint

/** Claims one candidate, sends the email, and un-claims on failure. */
async function sendOne(user, slot, now) {
  const [claimed] = await db
    .update(users)
    .set({ meetingLinkSentAt: now })
    .where(and(eq(users.id, user.id), eq(users.slotId, slot.id), isNull(users.meetingLinkSentAt)))
    .returning({ id: users.id });
  if (!claimed) return "skipped"; // another run got there first

  try {
    await sendMail({
      to: user.email,
      ...meetingLinkEmail({ name: user.name, startTime: slot.startTime, meetLink: slot.meetLink }),
    });
    return "sent";
  } catch (err) {
    console.error(`[meeting-links] failed for ${user.email}:`, err.message);
    await db
      .update(users)
      .set({ meetingLinkSentAt: null })
      .where(and(eq(users.id, user.id), eq(users.meetingLinkSentAt, now)));
    return "failed";
  }
}

/**
 * Sends all meeting links that are due.
 * @returns {{ sent: number, failed: number, slotsMissingLink: string[] }}
 */
export async function dispatchDueMeetingLinks({ now = new Date() } = {}) {
  const settings = await getSettings();
  const leadMs = settings.meetingLinkLeadMinutes * MINUTE;

  const due = await db
    .select({ user: users, slot: slots })
    .from(users)
    .innerJoin(slots, eq(users.slotId, slots.id))
    .where(
      and(
        isNull(users.meetingLinkSentAt),
        lte(slots.startTime, new Date(now.getTime() + leadMs)),
        gte(slots.startTime, new Date(now.getTime() - MAX_SLOT_DURATION_MINUTES * MINUTE))
      )
    );

  const result = { sent: 0, failed: 0, slotsMissingLink: [] };
  for (const { user, slot } of due) {
    if (now >= slotEnd(slot)) continue; // interview already over
    if (!slot.meetLink) {
      if (!result.slotsMissingLink.includes(slot.id)) result.slotsMissingLink.push(slot.id);
      continue;
    }
    const outcome = await sendOne(user, slot, now);
    if (outcome === "sent") result.sent += 1;
    if (outcome === "failed") result.failed += 1;
  }

  if (!env.isTest && (result.sent || result.failed || result.slotsMissingLink.length)) {
    console.log("[meeting-links]", JSON.stringify(result));
  }
  return result;
}

/**
 * Emails the slot's link to every booked candidate immediately, regardless of
 * timing (admin "Send link now" button). Successful sends are recorded so the
 * scheduler doesn't send the same link again.
 */
export async function sendLinksForSlotNow(slot) {
  const booked = await db.select().from(users).where(eq(users.slotId, slot.id));
  const result = { sent: 0, failed: 0 };
  for (const user of booked) {
    try {
      await sendMail({
        to: user.email,
        ...meetingLinkEmail({ name: user.name, startTime: slot.startTime, meetLink: slot.meetLink }),
      });
      await db.update(users).set({ meetingLinkSentAt: new Date() }).where(eq(users.id, user.id));
      result.sent += 1;
    } catch (err) {
      console.error(`[meeting-links] manual send failed for ${user.email}:`, err.message);
      result.failed += 1;
    }
  }
  return result;
}

/**
 * Marks all candidates of a slot as "not yet notified" so the next dispatch
 * (re)sends the link - used when an admin changes the link.
 */
export async function resetSlotNotifications(slotId) {
  await db.update(users).set({ meetingLinkSentAt: null }).where(eq(users.slotId, slotId));
}

/**
 * Runs the dispatcher every minute inside the web process. Overlapping runs
 * are skipped. Returns a function that stops the scheduler.
 */
export function startMeetingLinkScheduler(intervalMs = MINUTE) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await dispatchDueMeetingLinks();
    } catch (err) {
      console.error("[meeting-links] scheduler error:", err.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref(); // never keep the process alive just for this
  tick();
  return () => clearInterval(timer);
}
