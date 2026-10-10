/**
 * Loading a candidate with everything that belongs to them, deriving their
 * stage, and the JSON shape the candidate dashboard receives.
 *
 * A "candidate" object is the `users` row plus `application`, `task`,
 * `review` and `slot` (each null when missing).
 */
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { MINUTE } from "../lib/time.js";

const { users, applications, taskAssignments, interviewReviews, slots } = schema;

/** The four stages, in order. */
export const STAGES = ["application", "task", "slot", "interview"];

/** Base query joining a user with all of their stage data. */
export function candidateQuery() {
  return db
    .select({
      user: users,
      application: applications,
      task: taskAssignments,
      review: interviewReviews,
      slot: slots,
    })
    .from(users)
    .leftJoin(applications, eq(applications.userId, users.id))
    .leftJoin(taskAssignments, eq(taskAssignments.userId, users.id))
    .leftJoin(interviewReviews, eq(interviewReviews.userId, users.id))
    .leftJoin(slots, eq(slots.id, users.slotId));
}

/** Flattens one joined row into a candidate object. */
export const toCandidate = (row) =>
  row && { ...row.user, application: row.application, task: row.task, review: row.review, slot: row.slot };

/** Loads one candidate by id (null if not found). */
export async function loadCandidate(userId) {
  const [row] = await candidateQuery().where(eq(users.id, userId));
  return toCandidate(row) || null;
}

/**
 * Splits a VIT Google display name like "RAHUL SHARMA 24BCE1234" into the
 * person's name and registration number. Names without a reg. no. are kept as-is.
 */
export function parseGoogleName(displayName = "") {
  const trimmed = String(displayName).trim().replace(/\s+/g, " ");
  const match = trimmed.match(/^(.*?)\s+(\d{2}[A-Za-z]{3}\d{4,5})$/);
  if (match) return { name: match[1], regNo: match[2].toUpperCase() };
  return { name: trimmed, regNo: null };
}

/** Derives which stage a candidate is currently in. */
export function getStage(c) {
  if (!c.application) return "application";
  if (!c.task?.submittedAt) return "task";
  if (!c.slotId) return "slot";
  return "interview";
}

/**
 * Task state:
 *  - awaiting:  applied, but no task exists for their domain yet
 *  - active:    task assigned, deadline not passed
 *  - submitted: task submitted (can still be updated until the deadline)
 *  - expired:   deadline passed without a submission
 */
export function getTaskStatus(c, now = new Date()) {
  if (!c.task) return "awaiting";
  if (c.task.submittedAt) return "submitted";
  return now > c.task.deadline ? "expired" : "active";
}

/** Slot end time. */
export const slotEnd = (slot) => new Date(slot.startTime.getTime() + slot.durationMinutes * MINUTE);

/** Booking details, revealing the meeting link only once it is released. */
export function serializeBooking(slot, settings, now = new Date()) {
  if (!slot) return null;
  const linkReleaseAt = new Date(slot.startTime.getTime() - settings.meetingLinkLeadMinutes * MINUTE);
  const endTime = slotEnd(slot);
  const linkReleased = now >= linkReleaseAt;
  return {
    slotId: slot.id,
    startTime: slot.startTime,
    endTime,
    durationMinutes: slot.durationMinutes,
    linkReleaseAt,
    linkReleased,
    meetLink: linkReleased ? slot.meetLink || null : null,
    canCancel: !linkReleased,
    isOver: now >= endTime,
  };
}

/** Everything the candidate dashboard needs in one payload. */
export function serializeCandidate(c, settings, now = new Date()) {
  const app = c.application;
  const task = c.task;
  const publishedResult =
    settings.resultsPublished && ["selected", "rejected"].includes(c.review?.status)
      ? c.review.status
      : null;

  return {
    id: c.id,
    name: c.name,
    email: c.email,
    regNo: c.regNo,
    picture: c.picture,
    stage: getStage(c),
    application: app
      ? {
          submittedAt: app.submittedAt,
          phone: app.phone,
          githubProfile: app.githubProfile,
          linkedinProfile: app.linkedinProfile,
          projectLink: app.projectLink,
          projectDescription: app.projectDescription,
          firstDomain: app.firstDomain,
          secondDomain: app.secondDomain,
          answers: app.answers,
          managementQuestion: app.managementQuestion,
          managementAnswer: app.managementAnswer,
        }
      : null,
    task: app
      ? {
          status: getTaskStatus(c, now),
          title: task?.title ?? null,
          description: task?.description ?? null,
          resources: task?.resources ?? [],
          domain: task?.domain ?? app.firstDomain,
          assignedAt: task?.assignedAt ?? null,
          deadline: task?.deadline ?? null,
          submissionLink: task?.submissionLink ?? null,
          submissionNotes: task?.submissionNotes ?? null,
          submittedAt: task?.submittedAt ?? null,
        }
      : null,
    booking: serializeBooking(c.slot, settings, now),
    result: publishedResult,
    serverTime: now,
  };
}
