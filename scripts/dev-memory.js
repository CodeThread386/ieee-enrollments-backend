/**
 * Local server with a throw-away in-memory Postgres (PGlite) - it never touches
 * Neon, and all data is gone when the process stops.
 *   npm run dev:memory           (empty database)
 *   npm run dev:memory -- --seed (with sample tasks and slots)
 *
 * Dev login is switched on so you can sign in with any email. Also used by the
 * frontend's Playwright E2E tests.
 */
process.env.DATABASE_URL = "pglite://memory";
process.env.DEV_LOGIN ||= "true";
process.env.ACCESS_TOKEN_SECRET ||= "dev-access-secret";
process.env.REFRESH_TOKEN_SECRET ||= "dev-refresh-secret";

// Import after env is prepared so config picks it up.
await import("../server.js");

if (process.argv.includes("--seed")) {
  // server.js connects asynchronously; `db` is a live binding, so poll it.
  const dbModule = await import("../db/index.js");
  while (!dbModule.db) await new Promise((resolve) => setTimeout(resolve, 100));
  const { seed } = await import("./seed.js");
  await seed();
}
