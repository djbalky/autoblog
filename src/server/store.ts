/**
 * Autonoblog — single storage switch.
 *
 * The whole app reads/writes the database through this one module:
 *  - `DATABASE_URL` set  -> Postgres (Neon) driver (src/server/pg.ts)
 *  - otherwise           -> SQLite (src/server/db.ts, the dev fallback)
 *
 * Both backends expose the same three-helper surface (`all`, `get`, `run`) with
 * identical signatures, so the DAL/business code never duplicates or branches
 * on the backend. Both are awaited here so callers always `await` regardless of
 * which backend is active.
 */
import {
  all as pgAll,
  get as pgGet,
  run as pgRun,
  migrate as pgMigrate,
  usingPostgres,
  type Row,
} from "./pg";
import {
  all as sqlAll,
  get as sqlGet,
  run as sqlRun,
  getDb,
  migrate as sqlMigrate,
  nowIso,
} from "./db";

export { nowIso, usingPostgres };
export type { Row };

/** Create/migrate whichever backend is active. Idempotent + safe to re-run. */
export async function migrate(): Promise<void> {
  if (usingPostgres()) {
    await pgMigrate();
  } else {
    sqlMigrate(getDb());
  }
}

/** SELECT — all rows. */
export async function all<T = Row>(
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  if (usingPostgres()) return pgAll<T>(sql, ...params);
  return sqlAll<T>(sql, ...params);
}

/** SELECT — first row or undefined. */
export async function get<T = Row>(
  sql: string,
  ...params: unknown[]
): Promise<T | undefined> {
  if (usingPostgres()) return pgGet<T>(sql, ...params);
  return sqlGet<T>(sql, ...params);
}

/** INSERT/UPDATE/DELETE — { lastInsertRowid, changes }. */
export async function run(
  sql: string,
  ...params: unknown[]
): Promise<{ lastInsertRowid: number; changes: number }> {
  if (usingPostgres()) return pgRun(sql, ...params);
  return sqlRun(sql, ...params);
}
