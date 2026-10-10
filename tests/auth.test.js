import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "../config/env.js";
import {
  app,
  clearDb,
  db,
  fakeGoogleToken,
  loginAdmin,
  loginCandidate,
  schema,
  startDb,
  stopDb,
} from "./helpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(clearDb);

const userCount = async () => (await db.select().from(schema.users)).length;

describe("candidate login", () => {
  it("rejects non-VIT accounts", async () => {
    const { res } = await loginCandidate({ email: "someone@gmail.com" });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/vitstudent\.ac\.in/);
    expect(await userCount()).toBe(0);
  });

  it("rejects look-alike domains", async () => {
    const { res } = await loginCandidate({ email: "x@evilvitstudent.ac.in" });
    expect(res.status).toBe(403);
  });

  it("registers a VIT student, parses the reg. no. and starts at the application stage", async () => {
    const { res } = await loginCandidate({
      email: "Rahul.Sharma2024@VITstudent.ac.in",
      name: "RAHUL SHARMA 24BCE1234",
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: "RAHUL SHARMA",
      regNo: "24BCE1234",
      email: "rahul.sharma2024@vitstudent.ac.in",
      stage: "application",
      task: null,
      booking: null,
    });
    // Session cookies are httpOnly.
    const cookies = res.headers["set-cookie"].join(";");
    expect(cookies).toMatch(/ieee_user_access=/);
    expect(cookies).toMatch(/HttpOnly/i);
  });

  it("logs an existing user back in with 200 and keeps a single account", async () => {
    await loginCandidate({ email: "same@vitstudent.ac.in" });
    const { res } = await loginCandidate({ email: "same@vitstudent.ac.in" });
    expect(res.status).toBe(200);
    expect(await userCount()).toBe(1);
  });

  it("protects /api/user and supports refresh + logout", async () => {
    expect((await request(app).get("/api/user")).status).toBe(401);

    const { agent } = await loginCandidate();
    expect((await agent.get("/api/user")).status).toBe(200);
    expect((await agent.post("/api/user/refresh-token")).status).toBe(200);

    expect((await agent.post("/api/user/logout")).status).toBe(200);
    expect((await agent.get("/api/user")).status).toBe(401);
    expect((await agent.post("/api/user/refresh-token")).status).toBe(401);
  });

  it("does not accept a candidate session on admin routes", async () => {
    const { agent } = await loginCandidate();
    expect((await agent.get("/api/admin")).status).toBe(401);
  });
});

describe("Google sign-in (ID token)", () => {
  const googleLogin = (claims) =>
    request(app)
      .post("/api/user")
      .send({ credential: fakeGoogleToken(claims), deviceId: "device-google-123" });

  it("accepts a verified VIT Google account", async () => {
    const res = await googleLogin({
      email: "asha@vitstudent.ac.in",
      name: "ASHA K 25BCE0042",
      hostedDomain: "vitstudent.ac.in",
      picture: "https://lh3.googleusercontent.com/a/x",
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ regNo: "25BCE0042", picture: "https://lh3.googleusercontent.com/a/x" });
  });

  it("rejects unverified emails and other domains", async () => {
    expect((await googleLogin({ email: "a@vitstudent.ac.in", emailVerified: false })).status).toBe(403);
    expect((await googleLogin({ email: "a@gmail.com" })).status).toBe(403);
    expect(
      (await googleLogin({ email: "a@vitstudent.ac.in", hostedDomain: "other.edu" })).status
    ).toBe(403);
  });

  it("rejects missing or invalid credentials", async () => {
    const missing = await request(app).post("/api/user").send({ deviceId: "device-123456" });
    expect(missing.status).toBe(401);
    const bad = await request(app).post("/api/user").send({ credential: "garbage", deviceId: "device-123456" });
    expect(bad.status).toBe(401);
  });

  it("ignores dev-login fields when DEV_LOGIN is off", async () => {
    env.devLogin = false;
    try {
      const { res } = await loginCandidate();
      expect(res.status).toBe(401);
    } finally {
      env.devLogin = true;
    }
  });
});

describe("admin login", () => {
  it("rejects emails that are not on an allow-list", async () => {
    const { res } = await loginAdmin("student@vitstudent.ac.in");
    expect(res.status).toBe(403);
  });

  it("logs in admins and superadmins with the right role", async () => {
    const { res: superRes } = await loginAdmin("super@vit.ac.in");
    expect(superRes.status).toBe(200);
    expect(superRes.body.data.role).toBe("superadmin");

    const { res: adminRes, agent } = await loginAdmin("admin@vitstudent.ac.in");
    expect(adminRes.body.data.role).toBe("admin");
    expect((await agent.get("/api/admin")).body.data.role).toBe("admin");
  });

  it("revokes access as soon as the email is removed from the allow-list", async () => {
    const { agent } = await loginAdmin("admin@vitstudent.ac.in");
    env.adminEmails.splice(env.adminEmails.indexOf("admin@vitstudent.ac.in"), 1);
    try {
      expect((await agent.get("/api/admin")).status).toBe(403);
    } finally {
      env.adminEmails.push("admin@vitstudent.ac.in");
    }
  });

  it("keeps admin and candidate sessions separate", async () => {
    const { agent } = await loginAdmin();
    expect((await agent.get("/api/user")).status).toBe(401);
  });
});

describe("public endpoints", () => {
  it("serves config, server time and health", async () => {
    const config = await request(app).get("/api/config");
    expect(config.status).toBe(200);
    expect(config.body.data).toMatchObject({
      allowedEmailDomain: "vitstudent.ac.in",
      googleClientId: "test-client-id.apps.googleusercontent.com",
      devLogin: true,
    });
    expect(config.body.data.domains.length).toBeGreaterThan(5);

    const time = await request(app).get("/api/server-time");
    expect(new Date(time.body.time).getTime()).toBeGreaterThan(0);

    expect((await request(app).get("/api/health")).status).toBe(200);
    expect((await request(app).get("/api/nope")).status).toBe(404);
  });
});
