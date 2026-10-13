import request from "supertest";
import { isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sendMail, sent } from "../lib/mail.js";
import { invalidateLinkSchedule } from "../services/linkSchedule.js";
import { dispatchDueMeetingLinks, runScheduledDispatch } from "../services/meetingLink.service.js";
import {
  app,
  candidateReadyToBook,
  clearDb,
  createSlot,
  createTask,
  db,
  loginAdmin,
  moveSlot,
  schema,
  startDb,
  stopDb,
} from "./helpers.js";

const LINK = "https://meet.google.com/abc-defg-hij";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  invalidateLinkSchedule(); // forget what the previous test's scheduler learned
  sent.length = 0;
  await createTask("Web Development");
});

/** Books a candidate into a slot that is then moved to start `minutes` from now. */
async function bookedCandidate({ minutes, meetLink = LINK } = {}) {
  const slot = await createSlot({ meetLink });
  const { agent } = await candidateReadyToBook();
  await agent.post(`/api/user/slots/${slot.id}/book`).expect(200);
  await moveSlot(slot.id, minutes);
  sent.length = 0; // ignore the booking confirmation
  return { agent, slot };
}

const linkEmails = () => sent.filter((m) => /interview link/.test(m.subject));

describe("meeting link dispatcher", () => {
  it("does not send links for slots more than 30 minutes away", async () => {
    await bookedCandidate({ minutes: 45 });
    const result = await dispatchDueMeetingLinks();
    expect(result.sent).toBe(0);
    expect(linkEmails()).toHaveLength(0);
  });

  it("sends the link once the slot is within 30 minutes - exactly once", async () => {
    await bookedCandidate({ minutes: 25 });
    expect((await dispatchDueMeetingLinks()).sent).toBe(1);
    expect((await dispatchDueMeetingLinks()).sent).toBe(0);
    expect(linkEmails()).toHaveLength(1);
    expect(linkEmails()[0].html).toContain(LINK);
  });

  it("doesn't double-send when several dispatchers run at the same time", async () => {
    await bookedCandidate({ minutes: 20 });
    const results = await Promise.all([1, 2, 3, 4].map(() => dispatchDueMeetingLinks()));
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(1);
  });

  it("reports slots that are due but have no link, and sends once a link is added", async () => {
    const { slot } = await bookedCandidate({ minutes: 20, meetLink: null });
    const result = await dispatchDueMeetingLinks();
    expect(result.slotsMissingLink).toEqual([slot.id]);

    const { agent: admin } = await loginAdmin("admin@vitstudent.ac.in");
    const res = await admin.put(`/api/admin/slots/${slot.id}`).send({ meetLink: LINK });
    expect(res.status).toBe(200);
    expect(linkEmails()).toHaveLength(1); // sent immediately on update
  });

  it("retries on the next run if sending failed", async () => {
    await bookedCandidate({ minutes: 20 });
    sendMail.mockRejectedValueOnce(new Error("SMTP down"));
    expect((await dispatchDueMeetingLinks()).failed).toBe(1);
    const notified = await db.select().from(schema.users).where(isNotNull(schema.users.meetingLinkSentAt));
    expect(notified).toHaveLength(0);
    expect((await dispatchDueMeetingLinks()).sent).toBe(1);
  });

  it("re-sends when an admin changes the link after it was sent", async () => {
    const { slot } = await bookedCandidate({ minutes: 20 });
    await dispatchDueMeetingLinks();
    const { agent: admin } = await loginAdmin();
    await admin
      .put(`/api/admin/slots/${slot.id}`)
      .send({ meetLink: "https://meet.google.com/new-link-xyz" })
      .expect(200);
    expect(linkEmails()).toHaveLength(2);
    expect(linkEmails()[1].html).toContain("new-link-xyz");
  });

  it("skips interviews that are already over", async () => {
    await bookedCandidate({ minutes: -30 }); // 20 min slot ended 10 min ago
    expect((await dispatchDueMeetingLinks()).sent).toBe(0);
  });
});

describe("background scheduler (keeps Neon idle)", () => {
  const MIN = 60 * 1000;

  it("skips the database while no link is due, then sends on time", async () => {
    await bookedCandidate({ minutes: 45 }); // link due in 15 minutes
    expect(await runScheduledDispatch()).toMatchObject({ sent: 0 }); // learns the due time
    expect(await runScheduledDispatch()).toEqual({ skipped: true });
    expect(await runScheduledDispatch({ now: new Date(Date.now() + 10 * MIN) })).toEqual({ skipped: true });

    const due = await runScheduledDispatch({ now: new Date(Date.now() + 16 * MIN) });
    expect(due).toMatchObject({ sent: 1 });
    expect(linkEmails()).toHaveLength(1);
  });

  it("stays idle when nothing is booked and wakes up as soon as someone books", async () => {
    expect(await runScheduledDispatch()).toMatchObject({ sent: 0 });
    expect(await runScheduledDispatch()).toEqual({ skipped: true });

    // Booking a slot that starts in 20 minutes must not wait for the cache.
    const slot = await createSlot({ meetLink: LINK, minutesFromNow: 20 });
    const { agent } = await candidateReadyToBook();
    await agent.post(`/api/user/slots/${slot.id}/book`).expect(409); // inside the 30-min booking cutoff
    await moveSlot(slot.id, 60);
    await agent.post(`/api/user/slots/${slot.id}/book`).expect(200);
    await moveSlot(slot.id, 20);
    expect(await runScheduledDispatch()).toMatchObject({ sent: 1 });
  });

  it("re-checks when the lead time setting changes", async () => {
    await bookedCandidate({ minutes: 90 });
    expect(await runScheduledDispatch()).toMatchObject({ sent: 0 });
    expect(await runScheduledDispatch()).toEqual({ skipped: true });

    const { agent: admin } = await loginAdmin();
    await admin.put("/api/admin/settings").send({ meetingLinkLeadMinutes: 120 }).expect(200);
    expect(await runScheduledDispatch()).toMatchObject({ sent: 1 });
  });
});

describe("meeting link on the candidate dashboard", () => {
  it("is hidden before release time and visible after", async () => {
    const { agent, slot } = await bookedCandidate({ minutes: 60 });
    let me = await agent.get("/api/user");
    expect(me.body.data.booking.meetLink).toBeNull();

    await moveSlot(slot.id, 20);
    me = await agent.get("/api/user");
    expect(me.body.data.booking).toMatchObject({ linkReleased: true, meetLink: LINK, canCancel: false });
  });
});

describe("cron endpoint", () => {
  it("requires the cron secret", async () => {
    expect((await request(app).post("/api/cron/meeting-links")).status).toBe(401);
    const wrong = await request(app).post("/api/cron/meeting-links").set("x-cron-secret", "nope");
    expect(wrong.status).toBe(401);
  });

  it("runs the dispatcher with a valid secret, and is a cheap no-op when nothing is due", async () => {
    await bookedCandidate({ minutes: 15 });
    const call = () => request(app).post("/api/cron/meeting-links").set("Authorization", "Bearer cron-secret");
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.body.data.sent).toBe(1);
    expect((await call()).body.data).toEqual({ skipped: true });
  });
});

describe("manual send", () => {
  it("lets an admin send the link immediately", async () => {
    const { slot } = await bookedCandidate({ minutes: 600 });
    const { agent: admin } = await loginAdmin("admin@vitstudent.ac.in");
    const res = await admin.post(`/api/admin/slots/${slot.id}/send-links`);
    expect(res.status).toBe(200);
    expect(res.body.data.sent).toBe(1);
    // The scheduler won't send it again later.
    await moveSlot(slot.id, 10);
    expect((await dispatchDueMeetingLinks()).sent).toBe(0);
  });
});
