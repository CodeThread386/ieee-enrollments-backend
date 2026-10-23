/**
 * Random task assignment.
 *
 * When a candidate submits their application they get one random active task
 * from their first-choice domain. The deadline is the end of the IST day that
 * `taskDurationHours` (default 48h) lands on, so a task assigned at any time
 * on the 24th is due by 11:59 PM on the 26th. If the domain has no tasks yet,
 * the candidate waits in the "awaiting" state and is assigned automatically as soon as an admin adds a
 * task for that domain (or on their next visit).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { env } from "../config/env.js";
import { db, schema } from "../db/index.js";
import { taskAssignedEmail } from "../lib/emailTemplates.js";
import { sendMailInBackground } from "../lib/mail.js";
import { endOfDayIST, HOUR } from "../lib/time.js";
import { loadCandidate } from "./candidate.service.js";

const { tasks, taskAssignments, applications, users } = schema;

/** Deadline for a task assigned at `assignedAt`: end of the IST day `durationHours` later. */
export function taskDeadline(assignedAt, durationHours) {
  return endOfDayIST(new Date(assignedAt.getTime() + durationHours * HOUR));
}

/**
 * Assigns a task to the candidate if they applied and don't have one yet.
 * Safe to call repeatedly and concurrently: `task_assignments.user_id` is the
 * primary key, so a second insert is simply ignored.
 *
 * @returns the up-to-date candidate
 */
export async function assignTaskIfNeeded(candidate, settings) {
  if (!candidate.application || candidate.task) return candidate;

  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.domain, candidate.application.firstDomain), eq(tasks.isActive, true)))
    .orderBy(sql`random()`)
    .limit(1);
  if (!task) return candidate; // nothing to assign yet -> "awaiting"

  const assignedAt = new Date();
  const deadline = taskDeadline(assignedAt, settings.taskDurationHours);
  const inserted = await db
    .insert(taskAssignments)
    .values({
      userId: candidate.id,
      taskId: task.id,
      title: task.title,
      description: task.description,
      resources: task.resources,
      domain: task.domain,
      assignedAt,
      deadline,
    })
    .onConflictDoNothing()
    .returning({ userId: taskAssignments.userId });

  if (inserted.length > 0) {
    await db
      .update(tasks)
      .set({ assignedCount: sql`${tasks.assignedCount} + 1` })
      .where(eq(tasks.id, task.id));
    sendMailInBackground({
      to: candidate.email,
      ...taskAssignedEmail({
        name: candidate.name,
        taskTitle: task.title,
        domain: task.domain,
        deadline,
        appUrl: env.appUrl,
      }),
    });
  }
  return loadCandidate(candidate.id);
}

/**
 * Assigns tasks to every candidate of `domain` who is still waiting for one.
 * Called right after an admin creates or re-activates a task.
 *
 * @returns number of candidates who received a task
 */
export async function assignWaitingCandidates(domain, settings) {
  const waiting = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(applications, eq(applications.userId, users.id))
    .leftJoin(taskAssignments, eq(taskAssignments.userId, users.id))
    .where(and(eq(applications.firstDomain, domain), isNull(taskAssignments.userId)));

  let assigned = 0;
  for (const { id } of waiting) {
    const candidate = await loadCandidate(id);
    const updated = await assignTaskIfNeeded(candidate, settings);
    if (updated?.task) assigned += 1;
  }
  return assigned;
}
