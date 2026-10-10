/**
 * Autonoblog — Postgres driver (Neon serverless over HTTP).
 *
 * Exposes the SAME three-helper surface the DAL uses (`all`, `get`, `run`),
 * plus an idempotent `migrate()` for the Postgres schema. The DAL/business
 * code imports from `../store` (single switch); this module is the Postgres
 * implementation behind it and is only ever constructed when `DATABASE_URL`
 * is present.
 *
 * Compensations made here so the existing DAL SQL (written portable but with
 * SQLite-isms) runs unchanged on Postgres:
 *  - `?` positional placeholders are translated to neon's `$1, $2, ...`.
 *  - `INSERT OR IGNORE` (SQLite) becomes `INSERT ... ON CONFLICT DO NOTHING`.
 *  - `run()` captures the inserted id via `RETURNING id` (neon exposes no
 *    lastInsertRowid) and reports `changes` as the number of returned rows.
 *
 * DATABASE_URL arrives wrapped as `="..."` and must be cleaned before use.
 * The value is never logged.
 */
import { neon } from "@neondatabase/serverless";
import {
  PG_EXTENSION_STATEMENTS,
  PG_SCHEMA_NAME,
  PG_SCHEMA_STATEMENTS,
} from "./pgSchema";

export type Row = Record<string, unknown>;

let _client: {
  query: (text: string, params?: unknown[]) => Promise<Row[]>;
} | null = null;

/** Strip the `="..."` wrapping that DATABASE_URL arrives with. */
export function cleanUrl(raw: string | undefined): string {
  if (!raw) return "";
  let s = raw.trim();
  const stripQuotes = (v: string) =>
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
      ? v.slice(1, -1)
      : v;
  s = stripQuotes(s);
  if (s.startsWith("=")) s = s.slice(1);
  s = s.trim();
  s = stripQuotes(s);
  return s;
}

/** The cleaned connection string, or null when DATABASE_URL is absent. */
export function pgUrl(): string | null {
  const raw = process.env.DATABASE_URL;
  if (!raw) return null;
  const u = cleanUrl(raw);
  return u ? u : null;
}

/** True when the app should use Postgres (DATABASE_URL present). */
export function usingPostgres(): boolean {
  return pgUrl() !== null;
}

/** Lazily construct the neon client. Throws only if a query runs without DATABASE_URL. */
export function getPg(): {
  query: (text: string, params?: unknown[]) => Promise<Row[]>;
} {
  if (!_client) {
    const url = pgUrl();
    if (!url) {
      throw new Error("DATABASE_URL is not set — cannot query Postgres.");
    }
    _client = neon(url) as {
      query: (text: string, params?: unknown[]) => Promise<Row[]>;
    };
  }
  return _client;
}

/** Rewrite `?` placeholders to `$1, $2, ...` in order. */
function translate(sql: string): { text: string; count: number } {
  let i = 0;
  const text = sql.replace(/\?/g, () => `$${++i}`);
  return { text, count: i };
}

/** Run a SELECT and return all rows. */
export async function all<T = Row>(
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const { text } = translate(sql);
  const rows = await getPg().query(text, params.length ? params : undefined);
  return rows as T[];
}

/** Run a SELECT and return the first row or undefined. */
export async function get<T = Row>(
  sql: string,
  ...params: unknown[]
): Promise<T | undefined> {
  const rows = await all<Row>(sql, ...params);
  return rows[0] as T | undefined;
}

/**
 * Tables with a composite primary key and NO single `id` column. Appending
 * `RETURNING id` to an INSERT into these would fail with "column id does not
 * exist", so they are excluded (their run() result is never used for the id).
 */
const IDLESS_TABLES = new Set([
  "role_permissions",
  "user_roles",
  "post_categories",
  "post_tags",
]);

/** Extract the target table name from an INSERT ... INTO <table> clause. */
function insertTarget(sql: string): string | null {
  const m = /^\s*INSERT INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)/i.exec(sql);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Run an INSERT/UPDATE/DELETE; returns `{ lastInsertRowid, changes }`.
 * Also rewrites `INSERT OR IGNORE` cleanly for Postgres.
 */
export async function run(
  sql: string,
  ...params: unknown[]
): Promise<{ lastInsertRowid: number; changes: number }> {
  let s = sql;
  let ignore = false;
  if (/^INSERT\s+OR\s+IGNORE\s+INTO/i.test(s)) {
    s = s.replace(/^INSERT\s+OR\s+IGNORE\s+INTO/i, "INSERT INTO");
    ignore = true;
  }
  const { text } = translate(s);
  const kind = /^\s*(INSERT|UPDATE|DELETE)/i.exec(text)?.[1]?.toUpperCase();

  let finalSql = text;
  if (ignore && !/ON CONFLICT/i.test(finalSql)) {
    finalSql = finalSql.trimEnd() + " ON CONFLICT DO NOTHING";
  }
  // Only ask for RETURNING on INSERT/UPDATE/DELETE, and never for composite-PK
  // join tables that have no `id` column.
  const hasIdlessTarget =
    kind === "INSERT" &&
    (insertTarget(finalSql) === null ||
      IDLESS_TABLES.has(insertTarget(finalSql) as string));
  if (
    !hasIdlessTarget &&
    (kind === "INSERT" || kind === "UPDATE" || kind === "DELETE") &&
    !/RETURNING/i.test(finalSql)
  ) {
    finalSql = finalSql.trimEnd() + " RETURNING id";
  }

  const rows = await getPg().query(
    finalSql,
    params.length ? params : undefined
  );
  if (kind === "INSERT") {
    const id =
      !hasIdlessTarget && rows.length > 0
        ? Number((rows[0] as { id?: unknown }).id)
        : 0;
    return { lastInsertRowid: Number.isFinite(id) ? id : 0, changes: rows.length };
  }
  if (kind === "UPDATE" || kind === "DELETE") {
    return { lastInsertRowid: 0, changes: rows.length };
  }
  return { lastInsertRowid: 0, changes: 0 };
}

/**
 * Idempotent Postgres migration: creates the schema exactly once and records
 * it in a `schema_migrations` table. All DDL is also `IF NOT EXISTS`, so a
 * partially-applied run can be safely retried.
 */
export async function migrate(): Promise<void> {
  const q = getPg();
  await q.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       name       TEXT NOT NULL UNIQUE,
       applied_at TEXT NOT NULL
     )`
  );
  const existing = await q.query(
    `SELECT name FROM schema_migrations WHERE name = $1`,
    [PG_SCHEMA_NAME]
  );
  if (existing.length === 0) {
    for (const stmt of PG_SCHEMA_STATEMENTS) {
      await q.query(stmt);
    }
    await q.query(
      `INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)`,
      [PG_SCHEMA_NAME, new Date().toISOString()]
    );
  }
  // Columns that arrived in later phases on top of the original schema.
  // ADD COLUMN IF NOT EXISTS is idempotent and runs even for DBs where the
  // original migration was already applied, so this is safe to run every boot.
  await q.query(
    `ALTER TABLE blog_settings ADD COLUMN IF NOT EXISTS config TEXT NOT NULL DEFAULT ''`
  );
  // Foundation extension (billing/usage tables, ContentJob pipeline tables and
  // the agent_runs.content_job_id column). Databases migrated before this phase
  // already have a schema_migrations row, so the guarded block above is skipped
  // for them; these statements are individually idempotent and therefore run on
  // every boot, which is what brings an existing database up to date.
  for (const stmt of PG_EXTENSION_STATEMENTS) {
    await q.query(stmt);
  }
}
