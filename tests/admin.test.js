import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applicationBody,
  candidateReadyToBook,
  clearDb,
  createSlot,
  createTask,
  db,
  getSlot,
  loginAdmin,
  loginCandidate,
  schema,
  startDb,
  stopDb,
} from "./helpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(clearDb);

const inHours = (h) => new Date(Date.now() + h * 3600000).toISOString();
const interviewerCount = async (slotId) =>
  (await db.select().from(schema.slotInterviewers).where(eq(schema.slotInterviewers.slotId, slotId))).length;

describe("permissions", () => {
  it("restricts superadmin-only actions", async () => {
    const { agent } = await loginAdmin("admin@vitstudent.ac.in");
    expect((await agent.get("/api/admin/stats")).status).toBe(200);
    expect((await agent.get("/api/admin/candidates")).status).toBe(200);
    expect((await agent.post("/api/admin/tasks").send({})).status).toBe(403);
    expect((await agent.post("/api/admin/slots").send({})).status).toBe(403);
    expect((await agent.put("/api/admin/settings").send({})).status).toBe(403);
    expect((await agent.get("/api/admin/candidates/export")).status).toBe(403);
  });

  it("lets admins edit the link but not the timing of a slot", async () => {
    const slot = await createSlot();
    const { agent } = await loginAdmin("admin@vitstudent.ac.in");
    expect(
      (await agent.put(`/api/admin/slots/${slot.id}`).send({ meetLink: "https://meet.google.com/x" })).status
    ).toBe(200);
    expect((await agent.put(`/api/admin/slots/${slot.id}`).send({ capacity: 5 })).status).toBe(403);
  });
});

describe("tasks", () => {
  it("supports create, edit, deactivate and delete rules", async () => {
    const { agent } = await loginAdmin();
    const invalid = await agent.post("/api/admin/tasks").send({ title: "x", domain: "Nope" });
    expect(invalid.status).toBe(400);
    const removed = await agent
      .post("/api/admin/tasks")
      .send({ title: "x", description: "y", domain: "DevOps" }); // domain was removed
    expect(removed.status).toBe(400);

    const created = await agent.post("/api/admin/tasks").send({
      title: "Secure login page",
      description: "Find and fix the vulnerabilities",
      domain: "Cyber Security",
      resources: ["https://owasp.org"],
    });
    expect(created.status).toBe(201);
    const { id } = created.body.data;

    const edited = await agent.put(`/api/admin/tasks/${id}`).send({ isActive: false });
    expect(edited.body.data.isActive).toBe(false);

    await db.update(schema.tasks).set({ assignedCount: 3 }).where(eq(schema.tasks.id, id));
    expect((await agent.delete(`/api/admin/tasks/${id}`)).status).toBe(409);
    await db.update(schema.tasks).set({ assignedCount: 0 }).where(eq(schema.tasks.id, id));
    expect((await agent.delete(`/api/admin/tasks/${id}`)).status).toBe(200);
  });
});

describe("slots", () => {
  it("creates a single slot and bulk slots", async () => {
    const { agent } = await loginAdmin();
    const single = await agent.post("/api/admin/slots").send({ startTime: inHours(5), capacity: 3 });
    expect(single.status).toBe(201);

    // 2 hours of 20 min slots with a 10 min gap -> 4 slots.
    const from = new Date(Date.now() + 24 * 3600000);
    const bulk = await agent.post("/api/admin/slots").send({
      mode: "bulk",
      from: from.toISOString(),
      to: new Date(from.getTime() + 2 * 3600000).toISOString(),
      durationMinutes: 20,
      gapMinutes: 10,
      domain: "Design",
    });
    expect(bulk.status).toBe(201);
    expect(bulk.body.data).toHaveLength(4);
    const design = await db.select().from(schema.slots).where(eq(schema.slots.domain, "Design"));
    expect(design).toHaveLength(4);
  });

  it("rejects past slots, deleting booked slots and lowering capacity below bookings", async () => {
    const { agent } = await loginAdmin();
    expect((await agent.post("/api/admin/slots").send({ startTime: inHours(-1) })).status).toBe(400);

    await createTask("Web Development");
    const slot = await createSlot({ capacity: 2 });
    const { agent: candidate } = await candidateReadyToBook();
    await candidate.post(`/api/user/slots/${slot.id}/book`).expect(200);
    expect((await agent.delete(`/api/admin/slots/${slot.id}`)).status).toBe(409);
    expect((await agent.put(`/api/admin/slots/${slot.id}`).send({ capacity: 0 })).status).toBe(400);

    const list = await agent.get("/api/admin/slots");
    expect(list.body.data[0].bookedUsers[0].email).toMatch(/@vitstudent\.ac\.in/);
    expect(list.body.data[0].seatsLeft).toBe(1);
  });

  it("removing a booking frees the seat", async () => {
    await createTask("Web Development");
    const slot = await createSlot();
    const { agent: candidate, user } = await candidateReadyToBook();
    await candidate.post(`/api/user/slots/${slot.id}/book`).expect(200);

    const { agent } = await loginAdmin();
    expect((await agent.delete(`/api/admin/candidates/${user.id}/booking`)).status).toBe(200);
    expect((await getSlot(slot.id)).bookedCount).toBe(0);
    expect((await candidate.get("/api/user")).body.data.stage).toBe("slot");
  });

  it("toggles the admin as an interviewer", async () => {
    const slot = await createSlot();
    const { agent } = await loginAdmin("admin@vitstudent.ac.in");
    await agent.post(`/api/admin/slots/${slot.id}/interviewers/me`).expect(200);
    expect(await interviewerCount(slot.id)).toBe(1);
    await agent.post(`/api/admin/slots/${slot.id}/interviewers/me`).expect(200);
    expect(await interviewerCount(slot.id)).toBe(0);
  });
});

describe("candidates", () => {
  it("lists, filters, reviews and exports candidates", async () => {
    await createTask("Web Development");
    const { agent: c1 } = await loginCandidate({ name: "ALICE A 24BCE0001" });
    await c1.post("/api/user/application").send(applicationBody()).expect(200);
    await loginCandidate({ name: "BOB B 24BCE0002" }); // not applied

    const { agent } = await loginAdmin();
    const all = await agent.get("/api/admin/candidates");
    expect(all.body.data.total).toBe(2);

    const search = await agent.get("/api/admin/candidates?search=alice");
    expect(search.body.data.items.map((i) => i.name)).toEqual(["ALICE A"]);

    const wildcard = await agent.get("/api/admin/candidates?search=%25");
    expect(wildcard.body.data.total).toBe(0); // "%" is matched literally

    const byStage = await agent.get("/api/admin/candidates?stage=application");
    expect(byStage.body.data.items.map((i) => i.name)).toEqual(["BOB B"]);

    const byDomain = await agent.get("/api/admin/candidates?domain=Design"); // second choice
    expect(byDomain.body.data.total).toBe(1);

    const { id } = search.body.data.items[0];
    const detail = await agent.get(`/api/admin/candidates/${id}`);
    expect(detail.body.data.application.phone).toBe("9876543210");
    expect(detail.body.data).not.toHaveProperty("refreshTokens");

    const review = await agent
      .put(`/api/admin/candidates/${id}/interview`)
      .send({ status: "selected", rating: 5, remarks: "Strong" });
    expect(review.status).toBe(200);
    expect((await agent.put(`/api/admin/candidates/${id}/interview`).send({ status: "maybe" })).status).toBe(400);
    expect((await agent.get(`/api/admin/candidates/${id}`)).body.data.interview).toMatchObject({
      status: "selected",
      rating: 5,
      reviewedBy: { name: "Board Member" },
    });

    const csv = await agent.get("/api/admin/candidates/export");
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.text).toContain("ALICE A");
    expect(csv.text).toContain("selected");
  });

  it("returns 404/400 for unknown or malformed candidate ids", async () => {
    const { agent } = await loginAdmin();
    expect((await agent.get("/api/admin/candidates/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await agent.get("/api/admin/candidates/abc")).status).toBe(400);
  });

  it("shows results to candidates only once published", async () => {
    await createTask("Web Development");
    const slot = await createSlot();
    const { agent: candidate, user } = await candidateReadyToBook();
    await candidate.post(`/api/user/slots/${slot.id}/book`).expect(200);

    const { agent } = await loginAdmin();
    await agent.put(`/api/admin/candidates/${user.id}/interview`).send({ status: "selected" }).expect(200);
    expect((await candidate.get("/api/user")).body.data.result).toBeNull();

    await agent.put("/api/admin/settings").send({ resultsPublished: true }).expect(200);
    expect((await candidate.get("/api/user")).body.data.result).toBe("selected");
  });

  it("reports stats", async () => {
    await createTask("Web Development");
    await candidateReadyToBook();
    const { agent } = await loginAdmin();
    const { body } = await agent.get("/api/admin/stats");
    expect(body.data).toMatchObject({ totalCandidates: 1, applications: 1, tasksSubmitted: 1 });
    const web = body.data.applicationsByDomain.find((d) => d.domain === "Web Development");
    expect(web).toMatchObject({ count: 1, hasActiveTask: true });
  });
});

describe("settings", () => {
  it("validates and saves settings", async () => {
    const { agent } = await loginAdmin();
    expect((await agent.put("/api/admin/settings").send({ taskDurationHours: 0 })).status).toBe(400);
    expect((await agent.put("/api/admin/settings").send({ applicationsOpen: "yes" })).status).toBe(400);
    const ok = await agent
      .put("/api/admin/settings")
      .send({ taskDurationHours: 72, announcement: "Interviews start Monday" });
    expect(ok.body.data).toMatchObject({ taskDurationHours: 72, announcement: "Interviews start Monday" });
    expect(ok.body.data).not.toHaveProperty("key");
  });
});
