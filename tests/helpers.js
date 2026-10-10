/**
 * Shared test helpers: in-memory database lifecycle, logged-in agents and
 * small factories for tasks/slots.
 */
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { createApp } from "../app.js";
import { connectDB, db, disconnectDB, schema } from "../db/index.js";

export const app = createApp();
export { db, schema };

export async function startDb() {
  await connectDB("pglite://memory");
}

export async function stopDb() {
  await disconnectDB();
}

/** Empties every table between tests. */
export async function clearDb() {
  await db.execute(sql`
    TRUNCATE users, admins, sessions, applications, tasks, task_assignments,
             slots, slot_interviewers, interview_reviews, settings
    RESTART IDENTITY CASCADE`);
}

/** Builds a fake Google ID token understood by the mocked verifier. */
export function fakeGoogleToken(claims) {
  return `test:${Buffer.from(JSON.stringify({ emailVerified: true, ...claims })).toString("base64")}`;
}

let counter = 0;

/**
 * Logs a candidate in through DEV_LOGIN and returns a cookie-keeping
 * supertest agent plus the login response.
 */
export async function loginCandidate({ email, name } = {}) {
  counter += 1;
  const agent = request.agent(app);
  const res = await agent.post("/api/user").send({
    devEmail: email ?? `student${counter}@vitstudent.ac.in`,
    devName: name ?? `STUDENT ${counter} 24BCE${String(1000 + counter)}`,
    deviceId: `device-${counter}-abcdef`,
  });
  return { agent, res };
}

export async function loginAdmin(email = "super@vit.ac.in") {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/admin")
    .send({ devEmail: email, devName: "Board Member", deviceId: "admin-device-123456" });
  return { agent, res };
}

/** A valid application body. */
export function applicationBody(overrides = {}) {
  return {
    phone: "9876543210",
    githubProfile: "octocat",
    linkedinProfile: "",
    projectLink: "https://example.com/project",
    projectDescription: "A thing I built",
    firstDomain: "Web Development",
    secondDomain: "Design",
    answers: {
      whyIeee: "To learn and build",
      currentSkills: "HTML, CSS",
      exploreNext: "React",
      pastExperience: "",
      commitment: "8 hours",
    },
    managementAnswer: "Talk to both and find common ground",
    ...overrides,
  };
}

export async function createTask(domain = "Web Development", overrides = {}) {
  const [task] = await db
    .insert(schema.tasks)
    .values({ title: `${domain} task`, description: "Build something", domain, ...overrides })
    .returning();
  return task;
}

export async function createSlot({ minutesFromNow = 24 * 60, ...rest } = {}) {
  const [slot] = await db
    .insert(schema.slots)
    .values({
      startTime: new Date(Date.now() + minutesFromNow * 60 * 1000),
      durationMinutes: 20,
      capacity: 1,
      ...rest,
    })
    .returning();
  return slot;
}

export async function getSlot(id) {
  const [slot] = await db.select().from(schema.slots).where(eq(schema.slots.id, id));
  return slot;
}

/** Moves a slot in time (bypassing the "no edits once booked" rule). */
export async function moveSlot(id, minutesFromNow) {
  await db
    .update(schema.slots)
    .set({ startTime: new Date(Date.now() + minutesFromNow * 60 * 1000) })
    .where(eq(schema.slots.id, id));
}

export async function setSettings(patch) {
  await db.insert(schema.settings).values({ key: "global", ...patch }).onConflictDoUpdate({
    target: schema.settings.key,
    set: patch,
  });
}

/** Logs in a candidate and takes them through application + task submission. */
export async function candidateReadyToBook(options = {}) {
  const { agent, res } = await loginCandidate(options);
  await agent.post("/api/user/application").send(applicationBody()).expect(200);
  await agent.post("/api/user/task").send({ submissionLink: "https://github.com/me/task" }).expect(200);
  return { agent, user: res.body.data };
}
