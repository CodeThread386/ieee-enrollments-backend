/**
 * Admin endpoints (mounted at /api/admin).
 *
 * Roles:
 *  - admin:      view candidates/slots, record interview reviews, manage
 *                meeting links and join slots as an interviewer
 *  - superadmin: everything above + tasks, slot creation/deletion, settings,
 *                deadline extensions, removing bookings and CSV export
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  sum,
} from "drizzle-orm";
import { DOMAINS, INTERVIEW_STATUSES } from "../config/enrollment.js";
import { db, schema } from "../db/index.js";
import { clearSession, issueSession, refreshSession } from "../lib/auth.js";
import { HttpError } from "../lib/http.js";
import { MINUTE } from "../lib/time.js";
import {
  assertUuid,
  cleanDate,
  cleanEnum,
  cleanInt,
  cleanString,
  cleanUrl,
} from "../lib/validation.js";
import { getAdminRole } from "../middleware/auth.middleware.js";
import {
  candidateQuery,
  getStage,
  getTaskStatus,
  loadCandidate,
  slotEnd,
  toCandidate,
} from "../services/candidate.service.js";
import {
  dispatchDueMeetingLinks,
  resetSlotNotifications,
  sendLinksForSlotNow,
} from "../services/meetingLink.service.js";
import { invalidateLinkSchedule } from "../services/linkSchedule.js";
import { getSettings, serializeSettings, updateSettings as saveSettings } from "../services/settings.service.js";
import { generateSlotTimes, releaseBooking } from "../services/slot.service.js";
import { assignWaitingCandidates } from "../services/task.service.js";

const {
  admins,
  users,
  applications,
  taskAssignments,
  interviewReviews,
  tasks,
  slots,
  slotInterviewers,
} = schema;

const MAX_SLOT_DURATION_MINUTES = 240;

const adminView = (admin, role) => ({
  id: admin.id,
  name: admin.name,
  email: admin.email,
  picture: admin.picture,
  role,
});

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

/** POST /api/admin - log in after "Sign in with Google" (allow-listed emails only). */
export async function login(req, res) {
  const { email, emailVerified, name, picture } = req.identity;
  const deviceId = req.body?.deviceId;
  if (typeof deviceId !== "string" || deviceId.length < 8 || deviceId.length > 100) {
    throw new HttpError(400, "Device ID is required");
  }
  const normalisedEmail = String(email || "").toLowerCase();
  if (!normalisedEmail || !emailVerified) {
    throw new HttpError(403, "Your Google account email is not verified");
  }
  const role = getAdminRole(normalisedEmail);
  if (!role) throw new HttpError(403, "This account is not authorised for admin access");

  const [admin] = await db
    .insert(admins)
    .values({
      email: normalisedEmail,
      name: name || normalisedEmail.split("@")[0],
      picture: picture || null,
      lastLoginAt: new Date(),
    })
    .onConflictDoUpdate({
      target: admins.email,
      set: { lastLoginAt: new Date(), ...(picture && { picture }) },
    })
    .returning();

  await issueSession(res, "admin", admin.id, deviceId);
  return res.json({ success: true, message: "Login successful", data: adminView(admin, role) });
}

/** GET /api/admin */
export async function me(req, res) {
  return res.json({ success: true, data: adminView(req.admin, req.adminRole) });
}

/** POST /api/admin/refresh-token */
export async function refresh(req, res) {
  const adminId = await refreshSession(req, res, "admin");
  const [admin] = await db.select().from(admins).where(eq(admins.id, adminId));
  if (!admin || !getAdminRole(admin.email)) {
    throw new HttpError(403, "Your admin access has been revoked");
  }
  return res.json({ success: true, message: "Session refreshed" });
}

/** POST /api/admin/logout */
export async function logout(req, res) {
  await clearSession(req, res, "admin");
  return res.json({ success: true, message: "Logged out" });
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

/** Runs `select count(*)` with optional joins/conditions. */
const countOf = async (query) => Number((await query)[0]?.n ?? 0);

/** GET /api/admin/stats - numbers for the overview page. */
export async function stats(req, res) {
  const now = new Date();
  const soon = new Date(now.getTime() + 24 * 60 * MINUTE);

  const [
    totalCandidates,
    applicationCount,
    awaitingTask,
    tasksAssigned,
    tasksSubmitted,
    tasksExpired,
    booked,
    byDomain,
    interviewStatuses,
    activeTaskDomains,
    upcoming,
    missingLink,
  ] = await Promise.all([
    countOf(db.select({ n: count() }).from(users)),
    countOf(db.select({ n: count() }).from(applications)),
    countOf(
      db
        .select({ n: count() })
        .from(applications)
        .leftJoin(taskAssignments, eq(taskAssignments.userId, applications.userId))
        .where(isNull(taskAssignments.userId))
    ),
    countOf(db.select({ n: count() }).from(taskAssignments)),
    countOf(db.select({ n: count() }).from(taskAssignments).where(isNotNull(taskAssignments.submittedAt))),
    countOf(
      db
        .select({ n: count() })
        .from(taskAssignments)
        .where(and(isNull(taskAssignments.submittedAt), lt(taskAssignments.deadline, now)))
    ),
    countOf(db.select({ n: count() }).from(users).where(isNotNull(users.slotId))),
    db
      .select({ domain: applications.firstDomain, n: count() })
      .from(applications)
      .groupBy(applications.firstDomain),
    db
      .select({ status: sql`coalesce(${interviewReviews.status}, 'pending')`.as("status"), n: count() })
      .from(users)
      .leftJoin(interviewReviews, eq(interviewReviews.userId, users.id))
      .where(isNotNull(users.slotId))
      .groupBy(sql`coalesce(${interviewReviews.status}, 'pending')`),
    db.selectDistinct({ domain: tasks.domain }).from(tasks).where(eq(tasks.isActive, true)),
    db
      .select({ slots: count(), capacity: sum(slots.capacity), booked: sum(slots.bookedCount) })
      .from(slots)
      .where(gt(slots.startTime, now)),
    db
      .select()
      .from(slots)
      .where(and(gt(slots.startTime, now), lt(slots.startTime, soon), gt(slots.bookedCount, 0), isNull(slots.meetLink)))
      .orderBy(asc(slots.startTime)),
  ]);

  const activeDomains = activeTaskDomains.map((d) => d.domain);
  const totals = upcoming[0] || {};
  return res.json({
    success: true,
    data: {
      totalCandidates,
      applications: applicationCount,
      awaitingTask,
      tasksAssigned,
      tasksSubmitted,
      tasksExpired,
      booked,
      applicationsByDomain: DOMAINS.map((domain) => ({
        domain,
        count: Number(byDomain.find((d) => d.domain === domain)?.n ?? 0),
        hasActiveTask: activeDomains.includes(domain),
      })),
      interviews: Object.fromEntries(
        INTERVIEW_STATUSES.map((s) => [s, Number(interviewStatuses.find((i) => i.status === s)?.n ?? 0)])
      ),
      upcomingSlots: {
        slots: Number(totals.slots ?? 0),
        capacity: Number(totals.capacity ?? 0),
        booked: Number(totals.booked ?? 0),
      },
      slotsMissingLink: missingLink.map((s) => ({
        id: s.id,
        startTime: s.startTime,
        domain: s.domain,
        booked: s.bookedCount,
      })),
    },
  });
}

/* ------------------------------------------------------------------ */
/* Candidates                                                          */
/* ------------------------------------------------------------------ */

/** Escapes LIKE wildcards in user input. */
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Builds the SQL conditions for the candidate list from query params. */
function candidateConditions(query) {
  const conds = [];
  const now = new Date();

  const search = cleanString(query.search, { field: "search", max: 100 });
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    conds.push(or(ilike(users.name, pattern), ilike(users.email, pattern), ilike(users.regNo, pattern)));
  }

  const domain = cleanEnum(query.domain, DOMAINS, { field: "domain", required: false });
  if (domain) {
    conds.push(or(eq(applications.firstDomain, domain), eq(applications.secondDomain, domain)));
  }

  const stage = cleanEnum(query.stage, ["application", "task", "slot", "interview"], {
    field: "stage",
    required: false,
  });
  if (stage === "application") conds.push(isNull(applications.userId));
  if (stage === "task") conds.push(isNotNull(applications.userId), isNull(taskAssignments.submittedAt));
  if (stage === "slot") conds.push(isNotNull(taskAssignments.submittedAt), isNull(users.slotId));
  if (stage === "interview") conds.push(isNotNull(users.slotId));

  const taskStatus = cleanEnum(query.taskStatus, ["awaiting", "active", "submitted", "expired"], {
    field: "task status",
    required: false,
  });
  if (taskStatus === "awaiting") conds.push(isNotNull(applications.userId), isNull(taskAssignments.userId));
  if (taskStatus === "active") {
    conds.push(isNotNull(taskAssignments.userId), isNull(taskAssignments.submittedAt), gte(taskAssignments.deadline, now));
  }
  if (taskStatus === "submitted") conds.push(isNotNull(taskAssignments.submittedAt));
  if (taskStatus === "expired") {
    conds.push(isNotNull(taskAssignments.userId), isNull(taskAssignments.submittedAt), lt(taskAssignments.deadline, now));
  }

  const interviewStatus = cleanEnum(query.interviewStatus, INTERVIEW_STATUSES, {
    field: "interview status",
    required: false,
  });
  if (interviewStatus === "pending") {
    conds.push(or(isNull(interviewReviews.userId), eq(interviewReviews.status, "pending")));
  } else if (interviewStatus) {
    conds.push(eq(interviewReviews.status, interviewStatus));
  }

  return conds.length ? and(...conds) : undefined;
}

/** Compact row for the candidate table. */
function candidateRow(c, now) {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    regNo: c.regNo,
    picture: c.picture,
    stage: getStage(c),
    firstDomain: c.application?.firstDomain ?? null,
    secondDomain: c.application?.secondDomain ?? null,
    appliedAt: c.application?.submittedAt ?? null,
    taskStatus: c.application ? getTaskStatus(c, now) : null,
    taskTitle: c.task?.title ?? null,
    taskDeadline: c.task?.deadline ?? null,
    submissionLink: c.task?.submissionLink ?? null,
    slotTime: c.slot?.startTime ?? null,
    interviewStatus: c.review?.status ?? "pending",
    rating: c.review?.rating ?? null,
    createdAt: c.createdAt,
  };
}

/** GET /api/admin/candidates - filtered, paginated list. */
export async function listCandidates(req, res) {
  const page = cleanInt(req.query.page, { field: "page", min: 1, max: 100000, required: false }) || 1;
  const limit = cleanInt(req.query.limit, { field: "limit", min: 1, max: 100, required: false }) || 25;
  const where = candidateConditions(req.query);
  const now = new Date();

  const [rows, totalRows] = await Promise.all([
    candidateQuery()
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({ n: count() })
      .from(users)
      .leftJoin(applications, eq(applications.userId, users.id))
      .leftJoin(taskAssignments, eq(taskAssignments.userId, users.id))
      .leftJoin(interviewReviews, eq(interviewReviews.userId, users.id))
      .where(where),
  ]);
  const total = Number(totalRows[0]?.n ?? 0);

  return res.json({
    success: true,
    data: {
      items: rows.map((r) => candidateRow(toCandidate(r), now)),
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    },
  });
}

/** GET /api/admin/candidates/:id - everything about one candidate. */
export async function getCandidate(req, res) {
  const id = assertUuid(req.params.id, "candidate id");
  const c = await loadCandidate(id);
  if (!c) throw new HttpError(404, "Candidate not found");

  const [interviewers, reviewer] = await Promise.all([
    c.slot
      ? db
          .select({ id: admins.id, name: admins.name, email: admins.email })
          .from(slotInterviewers)
          .innerJoin(admins, eq(admins.id, slotInterviewers.adminId))
          .where(eq(slotInterviewers.slotId, c.slot.id))
      : [],
    c.review?.reviewedBy
      ? db.select({ name: admins.name, email: admins.email }).from(admins).where(eq(admins.id, c.review.reviewedBy))
      : [],
  ]);

  return res.json({
    success: true,
    data: {
      id: c.id,
      name: c.name,
      email: c.email,
      regNo: c.regNo,
      picture: c.picture,
      createdAt: c.createdAt,
      stage: getStage(c),
      taskStatus: c.application ? getTaskStatus(c) : null,
      application: c.application,
      task: c.task,
      slot: c.slot ? { ...c.slot, endTime: slotEnd(c.slot), interviewers } : null,
      meetingLinkSentAt: c.meetingLinkSentAt,
      interview: c.review ? { ...c.review, reviewedBy: reviewer[0] || null } : { status: "pending" },
    },
  });
}

/** PUT /api/admin/candidates/:id/interview - record the interview outcome. */
export async function reviewCandidate(req, res) {
  const id = assertUuid(req.params.id, "candidate id");
  const status = cleanEnum(req.body?.status, INTERVIEW_STATUSES, { field: "status" });
  const rating = cleanInt(req.body?.rating, { field: "Rating", min: 1, max: 5, required: false });
  const remarks = cleanString(req.body?.remarks, { field: "Remarks", max: 3000 });

  const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
  if (!exists) throw new HttpError(404, "Candidate not found");

  const review = { status, rating, remarks, reviewedBy: req.admin.id, reviewedAt: new Date() };
  const [saved] = await db
    .insert(interviewReviews)
    .values({ userId: id, ...review })
    .onConflictDoUpdate({ target: interviewReviews.userId, set: review })
    .returning();
  return res.json({ success: true, message: "Review saved", data: saved });
}

/** PUT /api/admin/candidates/:id/task-deadline - extend a task deadline. */
export async function extendTaskDeadline(req, res) {
  const id = assertUuid(req.params.id, "candidate id");
  const deadline = cleanDate(req.body?.deadline, { field: "deadline" });
  if (deadline <= new Date()) throw new HttpError(400, "The new deadline must be in the future");

  const updated = await db
    .update(taskAssignments)
    .set({ deadline })
    .where(eq(taskAssignments.userId, id))
    .returning({ userId: taskAssignments.userId });
  if (updated.length === 0) throw new HttpError(404, "Candidate not found or has no task assigned");
  return res.json({ success: true, message: "Deadline updated", data: { deadline } });
}

/** DELETE /api/admin/candidates/:id/booking - remove a candidate from their slot. */
export async function removeBooking(req, res) {
  const id = assertUuid(req.params.id, "candidate id");
  const [user] = await db.select().from(users).where(eq(users.id, id));
  if (!user) throw new HttpError(404, "Candidate not found");
  if (!user.slotId) throw new HttpError(400, "Candidate has no booking");
  await releaseBooking(user.id, user.slotId);
  return res.json({ success: true, message: "Booking removed" });
}

const csvCell = (value) => {
  if (value === null || value === undefined) return "";
  let str = value instanceof Date ? value.toISOString() : String(value);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@]/.test(str)) str = `'${str}`;
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

/** GET /api/admin/candidates/export - CSV of all candidates (current filters). */
export async function exportCandidates(req, res) {
  const rows = await candidateQuery().where(candidateConditions(req.query)).orderBy(asc(users.createdAt));
  const list = rows.map(toCandidate);
  const now = new Date();
  const questionIds = [
    ...new Set(list.flatMap((c) => (c.application?.answers || []).map((a) => a.questionId))),
  ];

  const header = [
    "Name", "Reg No", "Email", "Phone", "Stage", "First domain", "Second domain",
    "GitHub", "LinkedIn", "Project link", "Project description", "Applied at",
    ...questionIds, "Management question", "Management answer",
    "Task", "Task status", "Task deadline", "Submission link", "Submission notes", "Submitted at",
    "Slot", "Interview status", "Rating", "Remarks",
  ];
  const lines = list.map((c) => {
    const app = c.application || {};
    const answers = Object.fromEntries((app.answers || []).map((a) => [a.questionId, a.answer]));
    return [
      c.name, c.regNo, c.email, app.phone, getStage(c), app.firstDomain, app.secondDomain,
      app.githubProfile, app.linkedinProfile, app.projectLink, app.projectDescription, app.submittedAt,
      ...questionIds.map((id) => answers[id]), app.managementQuestion, app.managementAnswer,
      c.task?.title, c.application ? getTaskStatus(c, now) : "", c.task?.deadline,
      c.task?.submissionLink, c.task?.submissionNotes, c.task?.submittedAt,
      c.slot?.startTime, c.review?.status ?? (c.slotId ? "pending" : ""), c.review?.rating, c.review?.remarks,
    ].map(csvCell);
  });

  const csv = [header.map(csvCell), ...lines].map((r) => r.join(",")).join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="ieee-enrollments-${now.toISOString().slice(0, 10)}.csv"`
  );
  // BOM so Excel opens UTF-8 correctly.
  return res.send(`﻿${csv}`);
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

/** Validates task fields from the request body. */
function parseTaskBody(body = {}, { partial = false } = {}) {
  const data = {};
  if (!partial || body.title !== undefined) {
    data.title = cleanString(body.title, { field: "Title", required: true, max: 200 });
  }
  if (!partial || body.description !== undefined) {
    data.description = cleanString(body.description, { field: "Description", required: true, max: 5000 });
  }
  if (!partial || body.domain !== undefined) {
    data.domain = cleanEnum(body.domain, DOMAINS, { field: "domain" });
  }
  if (!partial || body.resources !== undefined) {
    const list = Array.isArray(body.resources) ? body.resources : [];
    if (list.length > 10) throw new HttpError(400, "At most 10 resource links");
    data.resources = list
      .filter((r) => typeof r === "string" && r.trim())
      .map((r) => cleanUrl(r, { field: "Resource link", required: true }));
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") throw new HttpError(400, "isActive must be true/false");
    data.isActive = body.isActive;
  }
  return data;
}

/** GET /api/admin/tasks */
export async function listTasks(req, res) {
  const rows = await db.select().from(tasks).orderBy(asc(tasks.domain), desc(tasks.createdAt));
  return res.json({ success: true, data: rows });
}

/** POST /api/admin/tasks - also assigns it to candidates waiting on this domain. */
export async function createTask(req, res) {
  const data = parseTaskBody(req.body);
  const [task] = await db.insert(tasks).values({ ...data, createdBy: req.admin.id }).returning();
  const assigned = task.isActive ? await assignWaitingCandidates(task.domain, await getSettings()) : 0;
  return res.status(201).json({
    success: true,
    message: assigned ? `Task created and assigned to ${assigned} waiting candidate(s)` : "Task created",
    data: task,
  });
}

/** PUT /api/admin/tasks/:id - edits apply to future assignments only. */
export async function updateTask(req, res) {
  const id = assertUuid(req.params.id, "task id");
  const data = parseTaskBody(req.body, { partial: true });
  if (Object.keys(data).length === 0) throw new HttpError(400, "Nothing to update");
  const [task] = await db.update(tasks).set(data).where(eq(tasks.id, id)).returning();
  if (!task) throw new HttpError(404, "Task not found");
  const assigned = task.isActive ? await assignWaitingCandidates(task.domain, await getSettings()) : 0;
  return res.json({
    success: true,
    message: assigned ? `Task updated and assigned to ${assigned} waiting candidate(s)` : "Task updated",
    data: task,
  });
}

/** DELETE /api/admin/tasks/:id - only tasks that were never assigned. */
export async function deleteTask(req, res) {
  const id = assertUuid(req.params.id, "task id");
  const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!task) throw new HttpError(404, "Task not found");
  if (task.assignedCount > 0) {
    throw new HttpError(409, "This task has already been assigned to candidates. Deactivate it instead of deleting.");
  }
  await db.delete(tasks).where(eq(tasks.id, id));
  return res.json({ success: true, message: "Task deleted" });
}

/* ------------------------------------------------------------------ */
/* Slots                                                               */
/* ------------------------------------------------------------------ */

/** Adds booked candidates and interviewers to a list of slot rows. */
async function withSlotDetails(rows) {
  const ids = rows.map((s) => s.id);
  if (ids.length === 0) return [];

  const [bookedRows, interviewerRows] = await Promise.all([
    db
      .select({
        id: users.id,
        slotId: users.slotId,
        name: users.name,
        email: users.email,
        regNo: users.regNo,
        picture: users.picture,
        meetingLinkSentAt: users.meetingLinkSentAt,
        firstDomain: applications.firstDomain,
        secondDomain: applications.secondDomain,
        reviewStatus: interviewReviews.status,
        submissionLink: taskAssignments.submissionLink,
      })
      .from(users)
      .leftJoin(applications, eq(applications.userId, users.id))
      .leftJoin(interviewReviews, eq(interviewReviews.userId, users.id))
      .leftJoin(taskAssignments, eq(taskAssignments.userId, users.id))
      .where(inArray(users.slotId, ids))
      .orderBy(asc(users.bookedAt)),
    db
      .select({ slotId: slotInterviewers.slotId, id: admins.id, name: admins.name, email: admins.email })
      .from(slotInterviewers)
      .innerJoin(admins, eq(admins.id, slotInterviewers.adminId))
      .where(inArray(slotInterviewers.slotId, ids)),
  ]);

  return rows.map((slot) => ({
    ...slot,
    endTime: slotEnd(slot),
    seatsLeft: slot.capacity - slot.bookedCount,
    bookedUsers: bookedRows
      .filter((u) => u.slotId === slot.id)
      .map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        regNo: u.regNo,
        picture: u.picture,
        meetingLinkSentAt: u.meetingLinkSentAt,
        application: { firstDomain: u.firstDomain, secondDomain: u.secondDomain },
        interview: { status: u.reviewStatus || "pending" },
        task: { submissionLink: u.submissionLink },
      })),
    interviewers: interviewerRows
      .filter((i) => i.slotId === slot.id)
      .map(({ id, name, email }) => ({ id, name, email })),
  }));
}

/** GET /api/admin/slots?scope=upcoming|past|all */
export async function listSlots(req, res) {
  const scope =
    cleanEnum(req.query.scope, ["upcoming", "past", "all"], { field: "scope", required: false }) || "upcoming";
  const now = new Date();
  // "upcoming" also keeps slots that are currently running.
  const boundary = new Date(now.getTime() - MAX_SLOT_DURATION_MINUTES * MINUTE);
  const where =
    scope === "upcoming" ? gte(slots.startTime, boundary) : scope === "past" ? lt(slots.startTime, now) : undefined;

  const rows = await db
    .select()
    .from(slots)
    .where(where)
    .orderBy(scope === "past" ? desc(slots.startTime) : asc(slots.startTime))
    .limit(1000);
  const visible = scope === "upcoming" ? rows.filter((s) => slotEnd(s) > now) : rows;
  return res.json({ success: true, data: await withSlotDetails(visible) });
}

/** Parses slot options shared by single and bulk creation. */
function parseSlotOptions(body) {
  return {
    durationMinutes:
      cleanInt(body.durationMinutes, { field: "Duration", min: 5, max: MAX_SLOT_DURATION_MINUTES, required: false }) ?? 20,
    capacity: cleanInt(body.capacity, { field: "Capacity", min: 1, max: 100, required: false }) ?? 1,
    domain: cleanEnum(body.domain, DOMAINS, { field: "domain", required: false }),
    meetLink: cleanUrl(body.meetLink, { field: "Meeting link" }),
    notes: cleanString(body.notes, { field: "Notes", max: 500 }),
  };
}

/**
 * POST /api/admin/slots
 *  - single: { startTime, durationMinutes, capacity, domain, meetLink, notes }
 *  - bulk:   { mode: "bulk", from, to, durationMinutes, gapMinutes, ... }
 */
export async function createSlots(req, res) {
  const body = req.body || {};
  const options = parseSlotOptions(body);
  const now = new Date();
  let times;

  if (body.mode === "bulk") {
    const from = cleanDate(body.from, { field: "start time" });
    const to = cleanDate(body.to, { field: "end time" });
    const gapMinutes = cleanInt(body.gapMinutes, { field: "Gap", min: 0, max: 120, required: false }) ?? 0;
    if (to <= from) throw new HttpError(400, "End time must be after start time");
    times = generateSlotTimes({ from, to, durationMinutes: options.durationMinutes, gapMinutes });
    if (times.length === 0) throw new HttpError(400, "The time range is shorter than one slot");
    if (times.length > 200) throw new HttpError(400, "That would create more than 200 slots - use a smaller range");
  } else {
    times = [cleanDate(body.startTime, { field: "start time" })];
  }
  if (times.some((t) => t <= now)) throw new HttpError(400, "Slots must be in the future");

  const created = await db
    .insert(slots)
    .values(times.map((startTime) => ({ ...options, startTime, createdBy: req.admin.id })))
    .returning();
  return res.status(201).json({
    success: true,
    message: `${created.length} slot(s) created`,
    data: created,
  });
}

/**
 * PUT /api/admin/slots/:id
 * Any admin may change meetLink/notes; superadmins may also change timing,
 * capacity and domain (timing only while nobody has booked).
 */
export async function updateSlot(req, res) {
  const id = assertUuid(req.params.id, "slot id");
  const [slot] = await db.select().from(slots).where(eq(slots.id, id));
  if (!slot) throw new HttpError(404, "Slot not found");
  const body = req.body || {};
  const update = {};

  if (body.meetLink !== undefined) update.meetLink = cleanUrl(body.meetLink, { field: "Meeting link" });
  if (body.notes !== undefined) update.notes = cleanString(body.notes, { field: "Notes", max: 500 });

  const superFields = ["startTime", "durationMinutes", "capacity", "domain"];
  if (superFields.some((f) => body[f] !== undefined)) {
    if (req.adminRole !== "superadmin") {
      throw new HttpError(403, "Only superadmins can change slot timing, capacity or domain");
    }
    if (body.capacity !== undefined) {
      const capacity = cleanInt(body.capacity, { field: "Capacity", min: 1, max: 100 });
      if (capacity < slot.bookedCount) {
        throw new HttpError(400, `Capacity can't be lower than the ${slot.bookedCount} existing booking(s)`);
      }
      update.capacity = capacity;
    }
    if (body.domain !== undefined) {
      update.domain = cleanEnum(body.domain, DOMAINS, { field: "domain", required: false });
    }
    if (body.startTime !== undefined || body.durationMinutes !== undefined) {
      if (slot.bookedCount > 0) throw new HttpError(400, "Can't change the time of a slot that already has bookings");
      if (body.startTime !== undefined) {
        const startTime = cleanDate(body.startTime, { field: "start time" });
        if (startTime <= new Date()) throw new HttpError(400, "Slots must be in the future");
        update.startTime = startTime;
      }
      if (body.durationMinutes !== undefined) {
        update.durationMinutes = cleanInt(body.durationMinutes, {
          field: "Duration",
          min: 5,
          max: MAX_SLOT_DURATION_MINUTES,
        });
      }
    }
  }
  if (Object.keys(update).length === 0) throw new HttpError(400, "Nothing to update");

  // The capacity condition re-checks bookings made since we read the slot.
  const [saved] = await db
    .update(slots)
    .set(update)
    .where(update.capacity ? and(eq(slots.id, id), sql`${slots.bookedCount} <= ${update.capacity}`) : eq(slots.id, id))
    .returning();
  if (!saved) throw new HttpError(409, "Bookings changed in the meantime - please refresh and try again");

  // If the link changed after it was already emailed, send the new one.
  if (slot.meetLink && saved.meetLink && slot.meetLink !== saved.meetLink) {
    await resetSlotNotifications(id);
  }
  invalidateLinkSchedule(); // link or timing may have changed
  if (saved.meetLink) await dispatchDueMeetingLinks();
  return res.json({ success: true, message: "Slot updated", data: saved });
}

/** DELETE /api/admin/slots/:id - only slots without bookings. */
export async function deleteSlot(req, res) {
  const id = assertUuid(req.params.id, "slot id");
  const deleted = await db
    .delete(slots)
    .where(and(eq(slots.id, id), eq(slots.bookedCount, 0)))
    .returning({ id: slots.id });
  if (deleted.length === 0) {
    const [exists] = await db.select({ id: slots.id }).from(slots).where(eq(slots.id, id));
    if (!exists) throw new HttpError(404, "Slot not found");
    throw new HttpError(409, "This slot has bookings. Remove the candidates first.");
  }
  return res.json({ success: true, message: "Slot deleted" });
}

/** POST /api/admin/slots/:id/interviewers/me - join/leave a slot as interviewer. */
export async function toggleInterviewer(req, res) {
  const id = assertUuid(req.params.id, "slot id");
  const [slot] = await db.select({ id: slots.id }).from(slots).where(eq(slots.id, id));
  if (!slot) throw new HttpError(404, "Slot not found");

  const removed = await db
    .delete(slotInterviewers)
    .where(and(eq(slotInterviewers.slotId, id), eq(slotInterviewers.adminId, req.admin.id)))
    .returning();
  if (removed.length === 0) {
    await db.insert(slotInterviewers).values({ slotId: id, adminId: req.admin.id }).onConflictDoNothing();
  }
  return res.json({
    success: true,
    message: removed.length ? "You left this slot" : "You joined this slot as an interviewer",
  });
}

/** POST /api/admin/slots/:id/send-links - email the link to everyone now. */
export async function sendSlotLinks(req, res) {
  const id = assertUuid(req.params.id, "slot id");
  const [slot] = await db.select().from(slots).where(eq(slots.id, id));
  if (!slot) throw new HttpError(404, "Slot not found");
  if (!slot.meetLink) throw new HttpError(400, "Add a meeting link to this slot first");
  if (slot.bookedCount === 0) throw new HttpError(400, "Nobody has booked this slot");
  const result = await sendLinksForSlotNow(slot);
  return res.json({
    success: true,
    message: `Link sent to ${result.sent} candidate(s)${result.failed ? `, ${result.failed} failed` : ""}`,
    data: result,
  });
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/** GET /api/admin/settings */
export async function getSettingsHandler(req, res) {
  return res.json({ success: true, data: serializeSettings(await getSettings()) });
}

/** PUT /api/admin/settings */
export async function updateSettingsHandler(req, res) {
  const body = req.body || {};
  const patch = {};
  for (const key of ["applicationsOpen", "slotBookingOpen", "resultsPublished"]) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "boolean") throw new HttpError(400, `${key} must be true/false`);
      patch[key] = body[key];
    }
  }
  if (body.taskDurationHours !== undefined) {
    patch.taskDurationHours = cleanInt(body.taskDurationHours, { field: "Task duration (hours)", min: 1, max: 336 });
  }
  if (body.meetingLinkLeadMinutes !== undefined) {
    patch.meetingLinkLeadMinutes = cleanInt(body.meetingLinkLeadMinutes, {
      field: "Meeting link lead time (minutes)",
      min: 5,
      max: 1440,
    });
  }
  if (body.announcement !== undefined) {
    patch.announcement = cleanString(body.announcement, { field: "Announcement", max: 500 }) || "";
  }
  if (Object.keys(patch).length === 0) throw new HttpError(400, "Nothing to update");
  const saved = await saveSettings(patch);
  return res.json({ success: true, message: "Settings saved", data: serializeSettings(saved) });
}
