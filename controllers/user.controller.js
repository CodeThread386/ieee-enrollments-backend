/**
 * Candidate endpoints (mounted at /api/user).
 */
import { and, eq, gte } from "drizzle-orm";
import { env } from "../config/env.js";
import {
  APPLICATION_QUESTIONS,
  DOMAINS,
  FIRST_CHOICE_DOMAINS,
  managementQuestionFor,
  SECOND_CHOICE_ONLY_DOMAINS,
} from "../config/enrollment.js";
import { db, schema, UNIQUE_VIOLATION } from "../db/index.js";
import { clearSession, issueSession, refreshSession } from "../lib/auth.js";
import { HttpError } from "../lib/http.js";
import {
  assertUuid,
  cleanEnum,
  cleanGithub,
  cleanPhone,
  cleanString,
  cleanUrl,
} from "../lib/validation.js";
import { loadCandidate, parseGoogleName, serializeCandidate } from "../services/candidate.service.js";
import { getSettings } from "../services/settings.service.js";
import { bookSlot, cancelBooking, listBookableSlots } from "../services/slot.service.js";
import { assignTaskIfNeeded } from "../services/task.service.js";

const { users, applications, taskAssignments } = schema;

/** Sends the full candidate payload (the frontend's single source of truth). */
async function sendCandidate(res, candidate, status = 200, message) {
  const settings = await getSettings();
  return res.status(status).json({
    success: true,
    ...(message && { message }),
    data: serializeCandidate(candidate, settings),
  });
}

/** Validates the device id the frontend generates once per browser. */
function cleanDeviceId(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 100) {
    throw new HttpError(400, "Device ID is required");
  }
  return value;
}

/**
 * POST /api/user - log in (or register) after "Sign in with Google".
 * Only verified emails on ALLOWED_EMAIL_DOMAIN (vitstudent.ac.in) may sign in.
 */
export async function login(req, res) {
  const { email, emailVerified, name, picture, hostedDomain } = req.identity;
  const deviceId = cleanDeviceId(req.body?.deviceId);

  const normalisedEmail = String(email || "").toLowerCase();
  if (!normalisedEmail || !emailVerified) {
    throw new HttpError(403, "Your Google account email is not verified");
  }
  const domainOk =
    normalisedEmail.endsWith(`@${env.allowedEmailDomain}`) &&
    (!hostedDomain || hostedDomain.toLowerCase() === env.allowedEmailDomain);
  if (!domainOk) {
    throw new HttpError(403, `Please sign in with your VIT student email (@${env.allowedEmailDomain})`);
  }

  const parsed = parseGoogleName(name || normalisedEmail.split("@")[0]);
  const [existing] = await db.select().from(users).where(eq(users.email, normalisedEmail));
  let userId = existing?.id;

  if (existing) {
    // Keep profile details fresh in case they changed on Google's side.
    await db
      .update(users)
      .set({ picture: picture || existing.picture, regNo: existing.regNo || parsed.regNo })
      .where(eq(users.id, existing.id));
  } else {
    const [created] = await db
      .insert(users)
      .values({ email: normalisedEmail, name: parsed.name, regNo: parsed.regNo, picture: picture || null })
      .onConflictDoNothing() // two simultaneous first logins
      .returning({ id: users.id });
    userId = created?.id ?? (await db.select().from(users).where(eq(users.email, normalisedEmail)))[0].id;
  }

  await issueSession(res, "user", userId, deviceId);
  return sendCandidate(res, await loadCandidate(userId), existing ? 200 : 201, "Login successful");
}

/** GET /api/user - the logged-in candidate's full state. */
export async function me(req, res) {
  const settings = await getSettings();
  // Lazily assign a task if one became available since the application.
  const candidate = await assignTaskIfNeeded(req.candidate, settings);
  return sendCandidate(res, candidate);
}

/** POST /api/user/refresh-token - issue a new access token. */
export async function refresh(req, res) {
  await refreshSession(req, res, "user");
  return res.json({ success: true, message: "Session refreshed" });
}

/** POST /api/user/logout */
export async function logout(req, res) {
  await clearSession(req, res, "user");
  return res.json({ success: true, message: "Logged out" });
}

/** GET /api/user/application/form - questions for the enrollment form. */
export async function getApplicationForm(req, res) {
  const settings = await getSettings();
  return res.json({
    success: true,
    data: {
      applicationsOpen: settings.applicationsOpen,
      domains: DOMAINS,
      // Some domains (e.g. Competitive Coding) can only be a second choice.
      firstChoiceDomains: FIRST_CHOICE_DOMAINS,
      questions: APPLICATION_QUESTIONS,
      managementQuestion: managementQuestionFor(req.candidate.id),
    },
  });
}

/** POST /api/user/application - submit the enrollment form (once). */
export async function submitApplication(req, res) {
  const settings = await getSettings();
  const candidate = req.candidate;
  const body = req.body || {};

  if (candidate.application) throw new HttpError(409, "You have already submitted your application");
  if (!settings.applicationsOpen) throw new HttpError(403, "Applications are closed");

  if (SECOND_CHOICE_ONLY_DOMAINS.includes(body.firstDomain)) {
    throw new HttpError(400, `${body.firstDomain} can only be chosen as a second choice`);
  }
  const firstDomain = cleanEnum(body.firstDomain, FIRST_CHOICE_DOMAINS, { field: "first-choice domain" });
  const secondDomain = cleanEnum(body.secondDomain, DOMAINS, {
    field: "second-choice domain",
    required: false,
  });
  if (secondDomain && secondDomain === firstDomain) {
    throw new HttpError(400, "Your second choice must be different from your first choice");
  }

  const rawAnswers = body.answers && typeof body.answers === "object" ? body.answers : {};
  const answers = APPLICATION_QUESTIONS.map((q) => ({
    questionId: q.id,
    question: q.label,
    answer: cleanString(rawAnswers[q.id], { field: `"${q.label}"`, required: q.required, max: q.maxLength }),
  }));
  const management = managementQuestionFor(candidate.id);

  const values = {
    userId: candidate.id,
    phone: cleanPhone(body.phone),
    githubProfile: cleanGithub(body.githubProfile),
    linkedinProfile: cleanUrl(body.linkedinProfile, { field: "LinkedIn profile", hostIncludes: "linkedin.com" }),
    projectLink: cleanUrl(body.projectLink, { field: "Project link" }),
    projectDescription: cleanString(body.projectDescription, { field: "Project description", max: 1000 }),
    firstDomain,
    secondDomain,
    answers,
    managementQuestionId: management.id,
    managementQuestion: management.text,
    managementAnswer: cleanString(body.managementAnswer, {
      field: "Management question answer",
      required: true,
      max: 1500,
    }),
  };

  try {
    await db.insert(applications).values(values);
  } catch (err) {
    // A double click can send two submissions - only the first one counts.
    if ((err.code || err.cause?.code) === UNIQUE_VIOLATION) {
      throw new HttpError(409, "You have already submitted your application");
    }
    throw err;
  }

  // Immediately hand out a random task for the first-choice domain.
  const updated = await assignTaskIfNeeded(await loadCandidate(candidate.id), settings);
  return sendCandidate(res, updated, 200, "Application submitted");
}

/** POST /api/user/task - submit (or update) the task link before the deadline. */
export async function submitTask(req, res) {
  const { task } = req.candidate;
  if (!task) throw new HttpError(400, "You don't have a task assigned yet");
  if (new Date() > task.deadline) throw new HttpError(403, "The deadline for this task has passed");

  const submissionLink = cleanUrl(req.body?.submissionLink, { field: "Submission link", required: true });
  const submissionNotes = cleanString(req.body?.submissionNotes, { field: "Notes", max: 1000 });
  const isUpdate = Boolean(task.submittedAt);

  // Conditional update so a request racing the deadline can't slip through.
  const now = new Date();
  const updated = await db
    .update(taskAssignments)
    .set({ submissionLink, submissionNotes, submittedAt: now })
    .where(and(eq(taskAssignments.userId, req.candidate.id), gte(taskAssignments.deadline, now)))
    .returning({ userId: taskAssignments.userId });
  if (updated.length === 0) throw new HttpError(403, "The deadline for this task has passed");

  return sendCandidate(
    res,
    await loadCandidate(req.candidate.id),
    200,
    isUpdate ? "Submission updated" : "Task submitted"
  );
}

/** GET /api/user/slots - bookable interview slots for this candidate. */
export async function getSlots(req, res) {
  const slots = await listBookableSlots(req.candidate, await getSettings());
  return res.json({ success: true, data: slots });
}

/** POST /api/user/slots/:slotId/book */
export async function book(req, res) {
  const slotId = assertUuid(req.params.slotId, "slot id");
  const candidate = await bookSlot(req.candidate, slotId, await getSettings());
  return sendCandidate(res, candidate, 200, "Slot booked");
}

/** DELETE /api/user/booking - cancel the current booking. */
export async function cancel(req, res) {
  const candidate = await cancelBooking(req.candidate, await getSettings());
  return sendCandidate(res, candidate, 200, "Booking cancelled");
}
