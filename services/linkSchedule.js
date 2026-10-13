/**
 * In-memory note of when the next meeting link is due.
 *
 * Why: Neon's free plan only has 100 compute-hours a month and suspends the
 * database after 5 idle minutes. If the scheduler (or an external keep-alive
 * cron) queried the database every minute, Neon would never sleep and the
 * allowance would run out mid-month. With this note, background runs only
 * touch the database when a link is actually due (or the note is stale).
 *
 * Anything that can change when a link is due (bookings, cancellations, slot
 * or link edits, the lead-time setting) calls `invalidateLinkSchedule()`.
 */
const MAX_STALENESS_MS = 6 * 60 * 60 * 1000; // re-check at least every 6h as a safety net

const state = {
  nextDueAt: undefined, // Date | null (nothing pending) | undefined (unknown)
  checkedAt: 0,
};

/** Forget the cached due time; the next background run will query the DB. */
export function invalidateLinkSchedule() {
  state.nextDueAt = undefined;
}

/** Remember the next due time (null = nothing pending). */
export function rememberNextDue(nextDueAt, now = new Date()) {
  state.nextDueAt = nextDueAt;
  state.checkedAt = now.getTime();
}

/** True if a background run can safely skip the database right now. */
export function canSkipDispatch(now = new Date()) {
  if (state.nextDueAt === undefined) return false;
  if (now.getTime() - state.checkedAt > MAX_STALENESS_MS) return false;
  return state.nextDueAt === null || now < state.nextDueAt;
}
