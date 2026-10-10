import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sent } from "../lib/mail.js";
import {
  applicationBody,
  clearDb,
  createTask,
  db,
  loginAdmin,
  loginCandidate,
  schema,
  setSettings,
  startDb,
  stopDb,
} from "./helpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  sent.length = 0;
});

const setDeadline = (userId, date) =>
  db.update(schema.taskAssignments).set({ deadline: date }).where(eq(schema.taskAssignments.userId, userId));

describe("application form", () => {
  it("serves the form with a management question that stays the same", async () => {
    const { agent } = await loginCandidate();
    const first = await agent.get("/api/user/application/form");
    const second = await agent.get("/api/user/application/form");
    expect(first.status).toBe(200);
    expect(first.body.data.questions.length).toBeGreaterThan(0);
    expect(first.body.data.managementQuestion).toEqual(second.body.data.managementQuestion);
  });

  it.each([
    [{ phone: "12345" }, /mobile number/],
    [{ firstDomain: "Underwater Basket Weaving" }, /first-choice domain/],
    [{ secondDomain: "Web Development" }, /different/],
    [{ githubProfile: "not a valid/user name" }, /GitHub/],
    [{ projectLink: "javascript:alert(1)" }, /link/],
    [{ linkedinProfile: "https://example.com/me" }, /linkedin/],
    [{ managementAnswer: "   " }, /required/],
    [{ answers: { whyIeee: "" } }, /required/],
    [{ firstDomain: { $ne: null } }, /first-choice domain/],
  ])("rejects invalid input %o", async (override, message) => {
    const { agent } = await loginCandidate();
    const res = await agent.post("/api/user/application").send(applicationBody(override));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
  });

  it("assigns a random task from the first-choice domain with a 48h deadline", async () => {
    await createTask("Design");
    const webTask = await createTask("Web Development");
    const { agent } = await loginCandidate();

    const before = Date.now();
    const res = await agent.post("/api/user/application").send(applicationBody());
    expect(res.status).toBe(200);

    const { data } = res.body;
    expect(data.stage).toBe("task");
    expect(data.application.githubProfile).toBe("https://github.com/octocat");
    expect(data.task.status).toBe("active");
    expect(data.task.title).toBe(webTask.title);
    const hours = (new Date(data.task.deadline).getTime() - before) / 3600000;
    expect(hours).toBeGreaterThan(47.9);
    expect(hours).toBeLessThan(48.1);

    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, webTask.id));
    expect(task.assignedCount).toBe(1);
    expect(sent.some((m) => /task is ready/.test(m.subject))).toBe(true);
  });

  it("spreads candidates randomly across the domain's tasks", async () => {
    for (const i of [1, 2, 3]) await createTask("Web Development", { title: `T${i}` });
    const titles = new Set();
    for (let i = 0; i < 12; i += 1) {
      const { agent } = await loginCandidate();
      const res = await agent.post("/api/user/application").send(applicationBody());
      titles.add(res.body.data.task.title);
    }
    expect(titles.size).toBeGreaterThan(1);
  });

  it("never assigns inactive tasks", async () => {
    await createTask("Web Development", { isActive: false });
    const { agent } = await loginCandidate();
    const res = await agent.post("/api/user/application").send(applicationBody());
    expect(res.body.data.task.status).toBe("awaiting");
  });

  it("accepts the application only once, even on a double click", async () => {
    const { agent } = await loginCandidate();
    const results = await Promise.all([
      agent.post("/api/user/application").send(applicationBody()),
      agent.post("/api/user/application").send(applicationBody()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const again = await agent.post("/api/user/application").send(applicationBody());
    expect(again.status).toBe(409);
  });

  it("blocks new applications when applications are closed", async () => {
    await setSettings({ applicationsOpen: false });
    const { agent } = await loginCandidate();
    const res = await agent.post("/api/user/application").send(applicationBody());
    expect(res.status).toBe(403);
  });

  it("waits when the domain has no task, then assigns it when an admin adds one", async () => {
    const { agent } = await loginCandidate();
    const res = await agent.post("/api/user/application").send(applicationBody());
    expect(res.body.data.task.status).toBe("awaiting");

    const { agent: admin } = await loginAdmin();
    const created = await admin.post("/api/admin/tasks").send({
      title: "Build a landing page",
      description: "Responsive landing page",
      domain: "Web Development",
      resources: ["https://developer.mozilla.org"],
    });
    expect(created.status).toBe(201);
    expect(created.body.message).toMatch(/assigned to 1/);

    const me = await agent.get("/api/user");
    expect(me.body.data.task).toMatchObject({ status: "active", title: "Build a landing page" });
  });
});

describe("task submission", () => {
  async function candidateWithTask() {
    await createTask("Web Development");
    const { agent, res } = await loginCandidate();
    await agent.post("/api/user/application").send(applicationBody()).expect(200);
    return { agent, userId: res.body.data.id };
  }

  it("requires an assigned task", async () => {
    const { agent } = await loginCandidate();
    const res = await agent.post("/api/user/task").send({ submissionLink: "https://x.com" });
    expect(res.status).toBe(400);
  });

  it("validates the link", async () => {
    const { agent } = await candidateWithTask();
    const res = await agent.post("/api/user/task").send({ submissionLink: "not a url" });
    expect(res.status).toBe(400);
  });

  it("accepts a submission and allows updating it before the deadline", async () => {
    const { agent } = await candidateWithTask();
    const first = await agent
      .post("/api/user/task")
      .send({ submissionLink: "https://github.com/me/v1", submissionNotes: "first" });
    expect(first.status).toBe(200);
    expect(first.body.data.stage).toBe("slot");
    expect(first.body.data.task.status).toBe("submitted");

    const second = await agent.post("/api/user/task").send({ submissionLink: "https://github.com/me/v2" });
    expect(second.body.message).toBe("Submission updated");
    expect(second.body.data.task.submissionLink).toBe("https://github.com/me/v2");
  });

  it("rejects submissions after the deadline and reports the task as expired", async () => {
    const { agent, userId } = await candidateWithTask();
    await setDeadline(userId, new Date(Date.now() - 1000));

    const res = await agent.post("/api/user/task").send({ submissionLink: "https://github.com/me/late" });
    expect(res.status).toBe(403);
    const me = await agent.get("/api/user");
    expect(me.body.data.task.status).toBe("expired");
    expect(me.body.data.stage).toBe("task");
  });

  it("lets a superadmin extend the deadline", async () => {
    const { agent, userId } = await candidateWithTask();
    await setDeadline(userId, new Date(Date.now() - 1000));

    const { agent: admin } = await loginAdmin();
    const extended = await admin
      .put(`/api/admin/candidates/${userId}/task-deadline`)
      .send({ deadline: new Date(Date.now() + 3600000).toISOString() });
    expect(extended.status).toBe(200);

    const res = await agent.post("/api/user/task").send({ submissionLink: "https://github.com/me/ok" });
    expect(res.status).toBe(200);
  });
});
