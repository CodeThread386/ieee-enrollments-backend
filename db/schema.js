/**
 * Database schema (Postgres via Drizzle ORM).
 *
 * After changing this file run `npm run db:generate` to create a new SQL
 * migration in /drizzle; migrations are applied automatically on server start
 * (or manually with `npm run db:migrate`).
 *
 * A candidate moves through four stages, derived from these tables
 * (see services/candidate.service.js#getStage):
 *   1. application  - row in `applications`
 *   2. task         - row in `task_assignments` (random task, due end of day 48h later)
 *   3. slot         - `users.slot_id` set (booked interview slot)
 *   4. interview    - meeting link released ~30 min before the slot
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const ts = (name) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () =>
  ts("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/* ------------------------------------------------------------------ */
/* People                                                              */
/* ------------------------------------------------------------------ */

/** Candidates (VIT students). */
export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    // VIT registration number parsed from the Google display name, e.g. 24BCE1234.
    regNo: text("reg_no"),
    picture: text("picture"),
    // The interview slot this candidate booked (null = not booked).
    slotId: uuid("slot_id").references(() => slots.id, { onDelete: "set null" }),
    bookedAt: ts("booked_at"),
    // Set once the meeting-link email for the current booking was delivered.
    meetingLinkSentAt: ts("meeting_link_sent_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("users_slot_idx").on(t.slotId)]
);

/** Board members / interviewers. Access itself is controlled by env allow-lists. */
export const admins = pgTable("admins", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  picture: text("picture"),
  lastLoginAt: ts("last_login_at"),
  createdAt: createdAt(),
});

/**
 * Login sessions (refresh tokens, stored hashed). One row per account+device.
 * `account_type` is "user" or "admin".
 */
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    accountType: text("account_type").notNull(),
    accountId: uuid("account_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    deviceId: text("device_id").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_account_idx").on(t.accountType, t.accountId)]
);

/* ------------------------------------------------------------------ */
/* Stage 1 - application form                                          */
/* ------------------------------------------------------------------ */

export const applications = pgTable(
  "applications",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    phone: text("phone").notNull(),
    githubProfile: text("github_profile"),
    linkedinProfile: text("linkedin_profile"),
    projectLink: text("project_link"),
    projectDescription: text("project_description"),
    firstDomain: text("first_domain").notNull(),
    secondDomain: text("second_domain"),
    // [{ questionId, question, answer }] - question text is snapshotted so
    // answers stay readable even if the wording changes later.
    answers: jsonb("answers").notNull().default([]),
    managementQuestionId: integer("management_question_id").notNull(),
    managementQuestion: text("management_question").notNull(),
    managementAnswer: text("management_answer").notNull(),
    submittedAt: ts("submitted_at").notNull().defaultNow(),
  },
  (t) => [index("applications_first_domain_idx").on(t.firstDomain)]
);

/* ------------------------------------------------------------------ */
/* Stage 2 - tasks                                                     */
/* ------------------------------------------------------------------ */

/** The task bank. Candidates get one random active task from their first domain. */
export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    domain: text("domain").notNull(),
    resources: jsonb("resources").notNull().default([]),
    // Inactive tasks are kept for history but never assigned again.
    isActive: boolean("is_active").notNull().default(true),
    assignedCount: integer("assigned_count").notNull().default(0),
    createdBy: uuid("created_by").references(() => admins.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("tasks_domain_active_idx").on(t.domain, t.isActive)]
);

/**
 * The task a candidate was given. Title/description are snapshotted so later
 * edits to the task bank never change what a candidate was asked to do.
 */
export const taskAssignments = pgTable("task_assignments", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description").notNull(),
  resources: jsonb("resources").notNull().default([]),
  domain: text("domain").notNull(),
  assignedAt: ts("assigned_at").notNull().defaultNow(),
  deadline: ts("deadline").notNull(),
  submissionLink: text("submission_link"),
  submissionNotes: text("submission_notes"),
  submittedAt: ts("submitted_at"),
});

/* ------------------------------------------------------------------ */
/* Stage 3/4 - interview slots                                         */
/* ------------------------------------------------------------------ */

/**
 * Interview slots. `booked_count` is maintained inside the booking
 * transaction and a CHECK constraint guarantees it never exceeds capacity.
 */
export const slots = pgTable(
  "slots",
  {
    id: id(),
    startTime: ts("start_time").notNull(),
    durationMinutes: integer("duration_minutes").notNull().default(20),
    capacity: integer("capacity").notNull().default(1),
    bookedCount: integer("booked_count").notNull().default(0),
    // Restrict to candidates whose first/second domain matches (null = anyone).
    domain: text("domain"),
    meetLink: text("meet_link"),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => admins.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("slots_start_time_idx").on(t.startTime),
    check("slots_capacity_check", sql`${t.bookedCount} >= 0 AND ${t.bookedCount} <= ${t.capacity}`),
    check("slots_duration_check", sql`${t.durationMinutes} BETWEEN 5 AND 240`),
  ]
);

/** Which admins interview in which slot. */
export const slotInterviewers = pgTable(
  "slot_interviewers",
  {
    slotId: uuid("slot_id")
      .notNull()
      .references(() => slots.id, { onDelete: "cascade" }),
    adminId: uuid("admin_id")
      .notNull()
      .references(() => admins.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.slotId, t.adminId] })]
);

/** Interview outcome recorded by an admin. */
export const interviewReviews = pgTable("interview_reviews", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  rating: integer("rating"),
  remarks: text("remarks"),
  reviewedBy: uuid("reviewed_by").references(() => admins.id, { onDelete: "set null" }),
  reviewedAt: ts("reviewed_at"),
});

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/** Global enrollment settings - a single row with key "global". */
export const settings = pgTable("settings", {
  key: text("key").primaryKey().default("global"),
  // Whether new applications (the enrollment form) are accepted.
  applicationsOpen: boolean("applications_open").notNull().default(true),
  // Whether candidates who submitted their task can book interview slots.
  slotBookingOpen: boolean("slot_booking_open").notNull().default(true),
  // Time to submit the task after it is assigned; the deadline rounds up to 11:59 PM IST that day.
  taskDurationHours: integer("task_duration_hours").notNull().default(48),
  // How long before the slot the meeting link is released (and booking closes).
  meetingLinkLeadMinutes: integer("meeting_link_lead_minutes").notNull().default(30),
  // When true candidates see "Selected" / "Not selected".
  resultsPublished: boolean("results_published").notNull().default(false),
  // Optional banner shown to every candidate.
  announcement: text("announcement").notNull().default(""),
  updatedAt: updatedAt(),
});
