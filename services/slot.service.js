/**
 * Interview slot booking.
 *
 * Booking runs in one transaction:
 *   1. Take a seat: `UPDATE slots SET booked_count = booked_count + 1` only if
 *      the slot is still in the future, matches the candidate's domain and
 *      has a free seat. Postgres row locks make concurrent bookings of the
 *      same slot wait for each other and re-check the condition, and a CHECK
 *      constraint (booked_count <= capacity) is the final safety net.
 *   2. Claim the candidate: set `users.slot_id` only if it is still empty
 *      (prevents one person booking two slots at the same time).
 * If either step fails, the whole transaction rolls back.
 */
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { env } from "../config/env.js";
import { db, schema } from "../db/index.js";
import { slotBookedEmail } from "../lib/emailTemplates.js";
import { HttpError } from "../lib/http.js";
import { sendMailInBackground } from "../lib/mail.js";
import { MINUTE } from "../lib/time.js";
import { loadCandidate, slotEnd } from "./candidate.service.js";
import { invalidateLinkSchedule } from "./linkSchedule.js";

const { slots, users } = schema;

/** Domains a candidate may book slots for (their first and second choice). */
const candidateDomains = (c) =>
  [c.application?.firstDomain, c.application?.secondDomain].filter(Boolean);

/** Booking closes when the meeting link is released (e.g. 30 min before). */
const bookingCutoff = (settings, now) =>
  new Date(now.getTime() + settings.meetingLinkLeadMinutes * MINUTE);

/** SQL condition: slot is open to this candidate's domains. */
const domainMatches = (c) =>
  or(isNull(slots.domain), inArray(slots.domain, candidateDomains(c)));

/** Throws if the candidate is not allowed to book right now. */
function assertCanBook(c, settings) {
  if (!settings.slotBookingOpen) {
    throw new HttpError(403, "Slot booking is currently closed. Please check back later.");
  }
  if (!c.task?.submittedAt) {
    throw new HttpError(403, "Submit your task before booking an interview slot");
  }
}

/** Upcoming slots with free seats that this candidate can book. */
export async function listBookableSlots(c, settings, now = new Date()) {
  assertCanBook(c, settings);
  const rows = await db
    .select()
    .from(slots)
    .where(
      and(
        gt(slots.startTime, bookingCutoff(settings, now)),
        lt(slots.bookedCount, slots.capacity),
        domainMatches(c)
      )
    )
    .orderBy(asc(slots.startTime))
    .limit(500);

  return rows.map((slot) => ({
    id: slot.id,
    startTime: slot.startTime,
    endTime: slotEnd(slot),
    durationMinutes: slot.durationMinutes,
    domain: slot.domain,
    seatsLeft: slot.capacity - slot.bookedCount,
    capacity: slot.capacity,
  }));
}

/** Books `slotId` for the candidate. Returns the updated candidate. */
export async function bookSlot(c, slotId, settings, now = new Date()) {
  assertCanBook(c, settings);
  if (c.slotId) throw new HttpError(409, "You have already booked a slot");

  const slot = await db.transaction(async (tx) => {
    const [seat] = await tx
      .update(slots)
      .set({ bookedCount: sql`${slots.bookedCount} + 1` })
      .where(
        and(
          eq(slots.id, slotId),
          gt(slots.startTime, bookingCutoff(settings, now)),
          lt(slots.bookedCount, slots.capacity),
          domainMatches(c)
        )
      )
      .returning();

    if (!seat) {
      const [exists] = await tx.select({ id: slots.id }).from(slots).where(eq(slots.id, slotId));
      if (!exists) throw new HttpError(404, "Slot not found");
      throw new HttpError(
        409,
        "Sorry, this slot just filled up or is no longer available. Please pick another one."
      );
    }

    const [claimed] = await tx
      .update(users)
      .set({ slotId, bookedAt: now, meetingLinkSentAt: null })
      .where(and(eq(users.id, c.id), isNull(users.slotId)))
      .returning({ id: users.id });
    if (!claimed) throw new HttpError(409, "You have already booked a slot");

    return seat;
  });
  invalidateLinkSchedule(); // a new link may now be due sooner

  sendMailInBackground({
    to: c.email,
    ...slotBookedEmail({
      name: c.name,
      startTime: slot.startTime,
      leadMinutes: settings.meetingLinkLeadMinutes,
      appUrl: env.appUrl,
    }),
  });
  return loadCandidate(c.id);
}

/**
 * Frees a candidate's seat (used by candidate cancel and admin removal).
 * Only acts if the candidate is still in `slotId`, so it is safe to retry.
 */
export async function releaseBooking(userId, slotId) {
  await db.transaction(async (tx) => {
    const [released] = await tx
      .update(users)
      .set({ slotId: null, bookedAt: null, meetingLinkSentAt: null })
      .where(and(eq(users.id, userId), eq(users.slotId, slotId)))
      .returning({ id: users.id });
    if (released) {
      await tx
        .update(slots)
        .set({ bookedCount: sql`${slots.bookedCount} - 1` })
        .where(eq(slots.id, slotId));
    }
  });
  invalidateLinkSchedule();
}

/** Cancels the candidate's booking (allowed until the link is released). */
export async function cancelBooking(c, settings, now = new Date()) {
  if (!c.slotId || !c.slot) throw new HttpError(400, "You don't have a booked slot");

  const changeDeadline = c.slot.startTime.getTime() - settings.meetingLinkLeadMinutes * MINUTE;
  if (now.getTime() >= changeDeadline) {
    throw new HttpError(
      403,
      `Bookings can only be changed until ${settings.meetingLinkLeadMinutes} minutes before the slot`
    );
  }
  await releaseBooking(c.id, c.slotId);
  return loadCandidate(c.id);
}

/**
 * Generates slot start times between `from` and `to` (exclusive end), one
 * every `durationMinutes` plus an optional `gapMinutes` break.
 */
export function generateSlotTimes({ from, to, durationMinutes, gapMinutes = 0 }) {
  const times = [];
  const step = (durationMinutes + gapMinutes) * MINUTE;
  for (let t = from.getTime(); t + durationMinutes * MINUTE <= to.getTime(); t += step) {
    times.push(new Date(t));
  }
  return times;
}
