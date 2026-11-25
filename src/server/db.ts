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
    // Phase 4: posts.scheduled_at — the scheduler column (Phase 6 writes it).
    ensureColumn(db, "posts", "scheduled_at", "TEXT");
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_posts_scheduled ON posts(scheduled_at)"
    );
    // Phase 4b: pages lifecycle columns. page_revisions itself is created by
    // SCHEMA_STATEMENTS above; only the two late columns need a PRAGMA check.
    ensureColumn(db, "pages", "published_at", "TEXT");
    ensureColumn(db, "pages", "scheduled_at", "TEXT");
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_pages_scheduled ON pages(scheduled_at)"
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_pages_blog_status ON pages(blog_id, status)"
    );
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
    // Phase 5a: media library columns. `media` is created by SCHEMA_STATEMENTS,
    // so only the columns the library writes need a PRAGMA-guarded add (indexes
    // come after their columns — an index on a missing column fails).
    ensureColumn(db, "media", "width", "INTEGER");
    ensureColumn(db, "media", "height", "INTEGER");
    ensureColumn(db, "media", "alt_text", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "media", "mime_type", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "media", "size_bytes", "INTEGER NOT NULL DEFAULT 0");
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_media_blog_created ON media(blog_id, created_at DESC)"
    );
    // Phase 6a: what a ContentJob is about, and the worker's free-text note.
    ensureColumn(db, "content_jobs", "topic", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "content_jobs", "brief", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "scheduler_state", "last_note", "TEXT NOT NULL DEFAULT ''");
    // Phase 6b-prep: the Connections hub. `integrations.blog_id` was NOT NULL in
    // the v1 schema and workspace-scoped rows have no blog, so the table is
    // rebuilt once (SQLite cannot drop a NOT NULL) before the new columns land.
    relaxIntegrationsBlogId(db);
    ensureColumn(db, "integrations", "scope", "TEXT NOT NULL DEFAULT 'blog'");
    ensureColumn(db, "integrations", "scope_id", "INTEGER");
    ensureColumn(db, "integrations", "label", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "integrations", "config_json", "TEXT NOT NULL DEFAULT '{}'");
    ensureColumn(db, "integrations", "secret_blob", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "integrations", "secret_hint", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "integrations", "connected_by", "INTEGER");
    ensureColumn(db, "integrations", "connected_at", "TEXT");
    ensureColumn(db, "integrations", "last_tested_at", "TEXT");
    ensureColumn(db, "integrations", "last_test_ok", "INTEGER");
    ensureColumn(db, "integrations", "last_test_message", "TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE integrations SET scope_id = blog_id WHERE scope_id IS NULL");
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_integrations_scope ON integrations(scope, scope_id)"
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
/**
 * SQLite cannot drop a NOT NULL constraint, so the v1 `integrations` table
 * (blog-scoped only) is rebuilt once to allow workspace-scoped rows
 * (blog_id NULL). Idempotent: it only runs while blog_id is still NOT NULL.
 */
function relaxIntegrationsBlogId(db: Database): void {
  const cols = db.query("PRAGMA table_info(integrations)").all() as {
    name: string;
    notnull: number;
  }[];
  const blogId = cols.find((c) => c.name === "blog_id");
  if (!blogId || blogId.notnull !== 1) return;
  db.exec(`CREATE TABLE integrations_rebuild (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id           INTEGER REFERENCES blogs(id) ON DELETE CASCADE,
    provider          TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'not_connected',
    config            TEXT NOT NULL DEFAULT '',
    error_message     TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    scope             TEXT NOT NULL DEFAULT 'blog',
    scope_id          INTEGER,
    label             TEXT NOT NULL DEFAULT '',
    config_json       TEXT NOT NULL DEFAULT '{}',
    secret_blob       TEXT NOT NULL DEFAULT '',
    secret_hint       TEXT NOT NULL DEFAULT '',
    connected_by      INTEGER,
    connected_at      TEXT,
    last_tested_at    TEXT,
    last_test_ok      INTEGER,
    last_test_message TEXT NOT NULL DEFAULT ''
  )`);
  db.exec(`INSERT INTO integrations_rebuild
    (id, blog_id, provider, status, config, error_message, created_at, updated_at,
     scope, scope_id)
    SELECT id, blog_id, provider, status, config, error_message, created_at, updated_at,
           'blog', blog_id
    FROM integrations`);
  db.exec("DROP TABLE integrations");
  db.exec("ALTER TABLE integrations_rebuild RENAME TO integrations");
  db.exec("CREATE INDEX IF NOT EXISTS idx_integrations_blog ON integrations(blog_id)");
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
