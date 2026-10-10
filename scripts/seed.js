/**
 * Seeds sample tasks (one per domain) and a few interview slots so the app can
 * be tried end-to-end locally.  Usage:  npm run seed
 *
 * The sample tasks are placeholders - replace them with the board's real
 * tasks from the admin dashboard before enrollments open.
 * Refuses to run in production unless --force is passed.
 */
import { count, gt } from "drizzle-orm";
import { env } from "../config/env.js";
import { DOMAINS } from "../config/enrollment.js";
import { connectDB, db, disconnectDB, schema } from "../db/index.js";
import { HOUR, MINUTE } from "../lib/time.js";

const { tasks, slots } = schema;

/** Inserts sample data into an empty database (uses the current connection). */
export async function seed() {
  const [{ n: taskCount }] = await db.select({ n: count() }).from(tasks);
  if (Number(taskCount) === 0) {
    await db.insert(tasks).values(
      DOMAINS.map((domain) => ({
        domain,
        title: `${domain}: sample task`,
        description:
          `This is a placeholder task for ${domain}. Replace it from the admin dashboard ` +
          "(Tasks tab) with the real task before enrollments open.\n\n" +
          "Submit a public link (GitHub repository, Google Drive folder, Figma file, ...) " +
          "that contains your work and a short README explaining your approach.",
        resources: ["https://ieeevit.org"],
      }))
    );
    console.log(`[seed] created ${DOMAINS.length} sample tasks`);
  } else {
    console.log(`[seed] ${taskCount} tasks already exist - skipping tasks`);
  }

  const [{ n: upcoming }] = await db.select({ n: count() }).from(slots).where(gt(slots.startTime, new Date()));
  if (Number(upcoming) === 0) {
    // Six slots starting tomorrow at 17:00 IST, every 30 minutes.
    const day = new Date(Date.now() + 24 * HOUR).toISOString().slice(0, 10);
    const base = new Date(`${day}T17:00:00+05:30`);
    await db.insert(slots).values(
      Array.from({ length: 6 }, (_, i) => ({
        startTime: new Date(base.getTime() + i * 30 * MINUTE),
        durationMinutes: 20,
        capacity: 2,
        meetLink: "https://meet.google.com/abc-defg-hij",
      }))
    );
    console.log("[seed] created 6 sample slots");
  } else {
    console.log(`[seed] ${upcoming} upcoming slots already exist - skipping slots`);
  }
}

// Run directly: `node scripts/seed.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    if (env.isProduction && !process.argv.includes("--force")) {
      throw new Error("Refusing to seed in production (pass --force if you really mean it)");
    }
    await connectDB(env.databaseUrl);
    await seed();
    await disconnectDB();
    process.exit(0);
  } catch (err) {
    console.error("[seed] failed:", err.message);
    process.exit(1);
  }
}
