/**
 * Applies pending database migrations (from /drizzle) and exits.
 *   npm run db:migrate
 *
 * The server also does this automatically on start, so this is mainly for
 * preparing a fresh database or checking a migration before deploying.
 */
import { env } from "../config/env.js";
import { connectDB, disconnectDB } from "../db/index.js";

try {
  await connectDB(env.databaseUrl);
  console.log("[migrate] database is up to date");
  await disconnectDB();
  process.exit(0);
} catch (err) {
  console.error("[migrate] failed:", err.message);
  process.exit(1);
}
