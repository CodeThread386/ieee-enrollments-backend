/**
 * Runs before every test file: test env vars + mocks for external services.
 * Tests use an in-memory Postgres (PGlite) and never touch Neon.
 */
import { vi } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "pglite://memory";
process.env.ACCESS_TOKEN_SECRET = "test-access-secret";
process.env.REFRESH_TOKEN_SECRET = "test-refresh-secret";
process.env.ALLOWED_EMAIL_DOMAIN = "vitstudent.ac.in";
process.env.ADMIN_EMAILS = "admin@vitstudent.ac.in";
process.env.SUPERADMIN_EMAILS = "super@vit.ac.in";
process.env.CRON_SECRET = "cron-secret";
process.env.ENABLE_INTERNAL_SCHEDULER = "false";
process.env.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
process.env.DEV_LOGIN = "true";

// Google: tests send "test:<base64 json claims>" instead of a real ID token.
vi.mock("../lib/google.js", () => ({
  verifyGoogleIdToken: vi.fn(async (token) => {
    if (!token.startsWith("test:")) throw new Error("invalid token");
    return JSON.parse(Buffer.from(token.slice(5), "base64").toString("utf8"));
  }),
}));

// Email: record messages instead of sending them.
vi.mock("../lib/mail.js", () => {
  const sent = [];
  const sendMail = vi.fn(async (message) => {
    sent.push(message);
    return { messageId: String(sent.length) };
  });
  return {
    sent,
    sendMail,
    sendMailInBackground: vi.fn((message) => {
      sent.push(message);
    }),
  };
});
