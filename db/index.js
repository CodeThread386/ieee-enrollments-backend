/**
 * Database connection.
 *
 * - `DATABASE_URL=postgres(ql)://...`  Neon (or any Postgres) via node-postgres.
 * - `DATABASE_URL=pglite://memory`    an in-process Postgres (PGlite) that
 *   lives only in memory - used by tests and `npm run dev:memory`, so they
 *   never touch the real database.
 *
 * `db` is a live ES-module binding: import it anywhere and it refers to the
 * connection created by `connectDB()`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

const MIGRATIONS_FOLDER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

/** @type {import("drizzle-orm/node-postgres").NodePgDatabase<typeof schema>} */
export let db = null;
let closeFn = async () => {};

/**
 * Connects to the database and applies pending migrations.
 * @param {string} url  DATABASE_URL
 */
export async function connectDB(url) {
  if (!url) throw new Error("DATABASE_URL is not set");

  if (url.startsWith("pglite:")) {
    // Loaded lazily: PGlite is a dev dependency and never needed in production.
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    closeFn = () => client.close();
    return db;
  }

  const { default: pg } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  // A dropped idle connection must not crash the process.
  pool.on("error", (err) => console.error("[db] idle client error:", err.message));
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  console.log(`[db] connected to ${new URL(url).hostname}`);
  closeFn = () => pool.end();
  return db;
}

/** Closes the connection (graceful shutdown, scripts, tests). */
export async function disconnectDB() {
  await closeFn();
  db = null;
}

/** True if a query can be run (used by the health check). */
export async function isDbHealthy() {
  if (!db) return false;
  try {
    await db.execute("select 1");
    return true;
  } catch {
    return false;
  }
}

/** Postgres unique-violation error code. */
export const UNIQUE_VIOLATION = "23505";
/** Postgres check-violation error code. */
export const CHECK_VIOLATION = "23514";

export { schema };
