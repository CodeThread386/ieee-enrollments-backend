import { isNotNull, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applicationBody,
  candidateReadyToBook,
  clearDb,
  createSlot,
  createTask,
  db,
  getSlot,
  loginCandidate,
  moveSlot,
  schema,
  setSettings,
  startDb,
  stopDb,
} from "./helpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await createTask("Web Development");
});

const bookedUsers = () => db.select().from(schema.users).where(isNotNull(schema.users.slotId));
const unbookedUsers = () => db.select().from(schema.users).where(isNull(schema.users.slotId));

describe("slot listing", () => {
  it("is only available after the task is submitted", async () => {
    const { agent } = await loginCandidate();
    await agent.post("/api/user/application").send(applicationBody()).expect(200);
    const res = await agent.get("/api/user/slots");
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Submit your task/);
  });

  it("shows only future, non-full slots for the candidate's domains", async () => {
    const open = await createSlot();
    const design = await createSlot({ domain: "Design" }); // second choice -> visible
    await createSlot({ domain: "Electronics" }); // other domain -> hidden
    await createSlot({ minutesFromNow: 10 }); // inside the 30 min cutoff -> hidden
    await createSlot({ minutesFromNow: -60 }); // past -> hidden
    await createSlot({ bookedCount: 1 }); // full -> hidden

    const { agent } = await candidateReadyToBook();
    const res = await agent.get("/api/user/slots");
    expect(res.status).toBe(200);
    expect(res.body.data.map((s) => s.id).sort()).toEqual([open.id, design.id].sort());
    expect(res.body.data[0]).toHaveProperty("seatsLeft", 1);
  });

  it("is blocked while slot booking is closed", async () => {
    await setSettings({ slotBookingOpen: false });
    const { agent } = await candidateReadyToBook();
    expect((await agent.get("/api/user/slots")).status).toBe(403);
  });
});

describe("booking", () => {
  it("books a slot and hides the link until release time", async () => {
    const slot = await createSlot({ meetLink: "https://meet.google.com/aaa-bbbb-ccc" });
    const { agent } = await candidateReadyToBook();

    const res = await agent.post(`/api/user/slots/${slot.id}/book`);
    expect(res.status).toBe(200);
    expect(res.body.data.stage).toBe("interview");
    expect(res.body.data.booking).toMatchObject({
      slotId: slot.id,
      linkReleased: false,
      meetLink: null,
      canCancel: true,
    });
    expect((await getSlot(slot.id)).bookedCount).toBe(1);
  });

  it("never overbooks a slot under concurrent requests", async () => {
    const slot = await createSlot({ capacity: 2 });
    const candidates = [];
    for (let i = 0; i < 6; i += 1) candidates.push(await candidateReadyToBook());

    const results = await Promise.all(
      candidates.map(({ agent }) => agent.post(`/api/user/slots/${slot.id}/book`))
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);

    expect((await getSlot(slot.id)).bookedCount).toBe(2);
    expect(await bookedUsers()).toHaveLength(2);
    expect(await unbookedUsers()).toHaveLength(4); // free to book something else
  });

  it("prevents one candidate from booking two slots at once", async () => {
    const a = await createSlot();
    const b = await createSlot();
    const { agent } = await candidateReadyToBook();
    const results = await Promise.all([
      agent.post(`/api/user/slots/${a.id}/book`),
      agent.post(`/api/user/slots/${b.id}/book`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const total = (await getSlot(a.id)).bookedCount + (await getSlot(b.id)).bookedCount;
    expect(total).toBe(1); // the losing booking was rolled back
  });

  it("rejects slots for other domains and unknown ids", async () => {
    const other = await createSlot({ domain: "Electronics" });
    const { agent } = await candidateReadyToBook();
    expect((await agent.post(`/api/user/slots/${other.id}/book`)).status).toBe(409);
    expect((await agent.post("/api/user/slots/00000000-0000-4000-8000-000000000000/book")).status).toBe(404);
    expect((await agent.post("/api/user/slots/not-an-id/book")).status).toBe(400);
    expect(await bookedUsers()).toHaveLength(0);
  });

  it("allows cancelling before the link is released and then re-booking", async () => {
    const a = await createSlot();
    const b = await createSlot();
    const { agent } = await candidateReadyToBook();
    await agent.post(`/api/user/slots/${a.id}/book`).expect(200);

    const cancelled = await agent.delete("/api/user/booking");
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.stage).toBe("slot");
    expect((await getSlot(a.id)).bookedCount).toBe(0);

    await agent.post(`/api/user/slots/${b.id}/book`).expect(200);
  });

  it("blocks cancelling once the meeting link is released", async () => {
    const slot = await createSlot({ minutesFromNow: 120 });
    const { agent } = await candidateReadyToBook();
    await agent.post(`/api/user/slots/${slot.id}/book`).expect(200);
    await moveSlot(slot.id, 10);

    expect((await agent.delete("/api/user/booking")).status).toBe(403);
  });

  it("enforces capacity at the database level too", async () => {
    const slot = await createSlot({ capacity: 1, bookedCount: 1 });
    await expect(
      db.update(schema.slots).set({ bookedCount: 2 }).where(isNotNull(schema.slots.id))
    ).rejects.toThrow();
    expect((await getSlot(slot.id)).bookedCount).toBe(1);
  });
});
