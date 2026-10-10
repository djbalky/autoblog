/**
 * Autonoblog — database connection + migration runner (Phase 1).
 *
 * We persist to a real, local SQLite database (Bun's built-in `bun:sqlite` —
 * no native npm dependency to build). All SQL in `schema.ts` is written in a
 * portable, standard subset so the schema can be migrated to Postgres later
 * (see schema.ts header). This module is the only place that touches SQLite
 * specifics; DAL/business code goes through `getDb()` and the query helpers.
 *
 * The DB file lives at <site>/data/app.db (gitignored).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_STATEMENTS } from "./schema";

// The DB must live at a stable location that survives rebuilds/publishes.
// `import.meta.dirname` moves around after bundling (it becomes the bundle's
// dist dir), so pin the data dir to the project root via process.cwd() — the
// server always launches from the site root. Override with APP_DATA_DIR if
// ever needed.
export const DATA_DIR =
  process.env.APP_DATA_DIR ?? join(process.cwd(), "data");
export const DB_PATH = join(DATA_DIR, "app.db");

let _db: Database | null = null;

/** ISO-8601 UTC timestamp string for NOW (portable across DB engines). */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Open (once) and migrate the SQLite database. Safe to call from any server
 * handler — the handle is cached for the process lifetime.
 */
export function getDb(): Database {
  if (_db) return _db;
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH, { create: true });
  // Enforce foreign keys and WAL for durability/concurrency.
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  _db = db;
  return db;
}

/** Run every idempotent DDL statement. Safe to run repeatedly. */
export function migrate(db: Database): void {
  db.exec("BEGIN");
  try {
    for (const stmt of SCHEMA_STATEMENTS) {
      db.exec(stmt);
    }
    ensureColumn(db, "blog_settings", "config", "TEXT NOT NULL DEFAULT ''");
    // Foundation extension: attribute agent runs to the ContentJob that caused
    // them. Column first, then its index (the index cannot be created before
    // the column exists on an already-migrated database).
    ensureColumn(
      db,
      "agent_runs",
      "content_job_id",
      "INTEGER REFERENCES content_jobs(id) ON DELETE SET NULL"
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_agent_runs_job ON agent_runs(content_job_id)"
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
/**
 * Idempotently add a column to an existing table (SQLite's ADD COLUMN has no
 * IF NOT EXISTS, so we inspect PRAGMA first). Used for columns that arrived in
 * later phases on top of the original CREATE TABLE statements.
 */
function ensureColumn(
  db: Database,
  table: string,
  column: string,
  definition: string
): void {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(
      `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`
    );
  }
}

// ---- Tiny query helpers (typed-ish, wrapping bun:sqlite) ------------------

export type Row = Record<string, unknown>;

/** Run a SELECT and return all rows. */
export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return getDb().query(sql).all(...params) as T[];
}

/** Run a SELECT and return the first row or undefined. */
export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return getDb().query(sql).get(...params) as T | undefined;
}

/** Run an INSERT/UPDATE/DELETE; returns { lastInsertRowid, changes }. */
export function run(
  sql: string,
  ...params: unknown[]
): { lastInsertRowid: number; changes: number } {
  const info = getDb().query(sql).run(...params) as {
    lastInsertRowid: number | bigint;
    changes: number;
  };
  return { lastInsertRowid: Number(info.lastInsertRowid), changes: info.changes };
}
