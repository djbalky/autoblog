/**
 * Autonoblog — DAL: integration connections (Phase 6b-prep).
 *
 * One row per (scope, provider) in the existing `integrations` table, extended
 * with the connection columns the Connections hub needs:
 *
 *   scope = 'workspace'  -> scope_id is the owning user id (applies to all of
 *                           that user's blogs)
 *   scope = 'blog'       -> scope_id is the blog id (overrides the workspace row
 *                           for that blog only)
 *
 * The secret itself lives in `secret_blob` (AES-256-GCM) and is never read by
 * anything that renders — `listConnections()` returns only `secret_hint`.
 */
import { all, get, nowIso, run } from "../store";
import { decryptSecret, encryptSecret, secretHint } from "../integrations/crypto";

export type ScopeKind = "workspace" | "blog";

export interface ConnectionScope {
  kind: ScopeKind;
  /** user id for workspace scope, blog id for blog scope. */
  id: number;
}

export type ConnectionStatus = "connected" | "unverified" | "error" | "not_connected";

export interface IntegrationRecord {
  id: number;
  scope: ScopeKind;
  scopeId: number;
  provider: string;
  label: string;
  status: ConnectionStatus;
  config: Record<string, string>;
  secretHint: string;
  hasSecret: boolean;
  connectedBy: number | null;
  connectedAt: string | null;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string;
  updatedAt: string;
}

interface IntegrationDbRow {
  id: unknown;
  scope?: unknown;
  scope_id?: unknown;
  blog_id?: unknown;
  provider?: unknown;
  label?: unknown;
  status?: unknown;
  config_json?: unknown;
  secret_blob?: unknown;
  secret_hint?: unknown;
  connected_by?: unknown;
  connected_at?: unknown;
  last_tested_at?: unknown;
  last_test_ok?: unknown;
  last_test_message?: unknown;
  updated_at?: unknown;
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function parseConfig(raw: unknown): Record<string, string> {
  const s = text(raw);
  if (!s) return {};
  try {
    const parsed = JSON.parse(s) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      out[k] = typeof v === "string" ? v : String(v ?? "");
    }
    return out;
  } catch {
    return {};
  }
}

function toStatus(raw: unknown): ConnectionStatus {
  const s = text(raw);
  if (s === "connected" || s === "unverified" || s === "error") return s;
  return "not_connected";
}

function toRecord(row: IntegrationDbRow): IntegrationRecord {
  const scopeRaw = text(row.scope) || "blog";
  const scope: ScopeKind = scopeRaw === "workspace" ? "workspace" : "blog";
  const scopeId =
    row.scope_id === null || row.scope_id === undefined
      ? num(row.blog_id)
      : num(row.scope_id);
  const lastOkRaw = row.last_test_ok;
  const lastTestOk =
    lastOkRaw === null || lastOkRaw === undefined || lastOkRaw === ""
      ? null
      : num(lastOkRaw) === 1;
  return {
    id: num(row.id),
    scope,
    scopeId,
    provider: text(row.provider),
    label: text(row.label),
    status: toStatus(row.status),
    config: parseConfig(row.config_json),
    secretHint: text(row.secret_hint),
    hasSecret: text(row.secret_blob).length > 0,
    connectedBy:
      row.connected_by === null || row.connected_by === undefined
        ? null
        : num(row.connected_by),
    connectedAt: text(row.connected_at) || null,
    lastTestedAt: text(row.last_tested_at) || null,
    lastTestOk,
    lastTestMessage: text(row.last_test_message),
    updatedAt: text(row.updated_at),
  };
}

/** Every stored connection in one scope (secrets excluded). */
export async function listConnections(
  scope: ConnectionScope
): Promise<IntegrationRecord[]> {
  const rows = await all<IntegrationDbRow>(
    "SELECT * FROM integrations WHERE scope = ? AND scope_id = ? ORDER BY provider ASC",
    scope.kind,
    scope.id
  );
  return rows.map(toRecord);
}

/** One stored connection, or null. Never includes the secret. */
export async function getConnection(
  scope: ConnectionScope,
  provider: string
): Promise<IntegrationRecord | null> {
  const row = await get<IntegrationDbRow>(
    "SELECT * FROM integrations WHERE scope = ? AND scope_id = ? AND provider = ?",
    scope.kind,
    scope.id,
    provider
  );
  return row ? toRecord(row) : null;
}

/**
 * The decrypted secret of one connection, or null when none is stored (or the
 * blob cannot be decrypted with the current key). Server-side only — the result
 * must never be sent to the browser.
 */
export async function getDecryptedSecret(
  scope: ConnectionScope,
  provider: string
): Promise<string | null> {
  const row = await get<IntegrationDbRow>(
    "SELECT secret_blob FROM integrations WHERE scope = ? AND scope_id = ? AND provider = ?",
    scope.kind,
    scope.id,
    provider
  );
  if (!row) return null;
  const blob = text(row.secret_blob);
  if (!blob) return null;
  return decryptSecret(blob);
}

export interface SaveConnectionInput {
  scope: ConnectionScope;
  provider: string;
  label: string;
  /** Non-secret fields only (already validated by the registry). */
  config: Record<string, string>;
  /** The secret to encrypt, or null/undefined to keep the stored one. */
  secret?: string | null;
  userId: number;
}

/**
 * Insert or update one connection. Saving a NEW secret clears the previous test
 * result (an untested credential must never keep an old "connected" badge).
 */
export async function saveConnection(
  input: SaveConnectionInput
): Promise<IntegrationRecord> {
  const existing = await getConnection(input.scope, input.provider);
  const now = nowIso();
  const configJson = JSON.stringify(input.config);
  const newSecret = (input.secret ?? "").trim();
  // A provider can be "saved" without a secret (e.g. an AdSense publisher id),
  // but it is never "connected" until a real test says so.
  const hasConfig = Object.values(input.config).some((v) => v.trim() !== "");
  const savedStatus: ConnectionStatus =
    newSecret || hasConfig ? "unverified" : "not_connected";

  if (!existing) {
    await run(
      `INSERT INTO integrations
         (blog_id, provider, status, config, error_message, created_at, updated_at,
          scope, scope_id, label, config_json, secret_blob, secret_hint, connected_by,
          connected_at, last_tested_at, last_test_ok, last_test_message)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '')`,
      input.scope.kind === "blog" ? input.scope.id : null,
      input.provider,
      savedStatus,
      "",
      now,
      now,
      input.scope.kind,
      input.scope.id,
      input.label,
      configJson,
      newSecret ? encryptSecret(newSecret) : "",
      newSecret ? secretHint(newSecret) : "",
      input.userId,
      newSecret ? now : null
    );
  } else if (newSecret) {
    await run(
      `UPDATE integrations
         SET label = ?, config_json = ?, secret_blob = ?, secret_hint = ?, status = ?,
             connected_by = ?, connected_at = ?, last_tested_at = NULL, last_test_ok = NULL,
             last_test_message = '', updated_at = ?
       WHERE id = ?`,
      input.label,
      configJson,
      encryptSecret(newSecret),
      secretHint(newSecret),
      savedStatus,
      input.userId,
      now,
      now,
      existing.id
    );
  } else {
    await run(
      `UPDATE integrations
         SET label = ?, config_json = ?, updated_at = ?
       WHERE id = ?`,
      input.label,
      configJson,
      now,
      existing.id
    );
  }

  const saved = await getConnection(input.scope, input.provider);
  if (!saved) {
    throw new Error("The connection could not be re-read after saving.");
  }
  return saved;
}

/** Record the outcome of a real test (or the honest "not verified" answer). */
export async function recordTestResult(
  scope: ConnectionScope,
  provider: string,
  outcome: { ok: boolean; verified: boolean; message: string }
): Promise<IntegrationRecord | null> {
  const existing = await getConnection(scope, provider);
  if (!existing) return null;
  const now = nowIso();
  const status: ConnectionStatus = outcome.verified
    ? outcome.ok
      ? "connected"
      : "error"
    : "unverified";
  await run(
    `UPDATE integrations
       SET last_tested_at = ?, last_test_ok = ?, last_test_message = ?, status = ?, updated_at = ?
     WHERE id = ?`,
    now,
    outcome.verified ? (outcome.ok ? 1 : 0) : null,
    outcome.message,
    status,
    now,
    existing.id
  );
  return getConnection(scope, provider);
}

/** Remove a connection row entirely. Returns true when a row was deleted. */
export async function deleteConnection(
  scope: ConnectionScope,
  provider: string
): Promise<boolean> {
  const existing = await getConnection(scope, provider);
  if (!existing) return false;
  await run("DELETE FROM integrations WHERE id = ?", existing.id);
  return true;
}

/** The owner of a blog — the user whose workspace connections apply to it. */
export async function getBlogOwnerId(blogId: number): Promise<number | null> {
  const row = await get<{ owner_id: unknown }>(
    "SELECT owner_id FROM blogs WHERE id = ?",
    blogId
  );
  if (!row) return null;
  const id = num(row.owner_id, -1);
  return id > 0 ? id : null;
}

/** Every stored row for a set of providers in one scope (resolver use). */
export async function listConnectionsForProviders(
  scope: ConnectionScope,
  providers: string[]
): Promise<IntegrationRecord[]> {
  if (providers.length === 0) return [];
  const placeholders = providers.map(() => "?").join(", ");
  const rows = await all<IntegrationDbRow>(
    `SELECT * FROM integrations
     WHERE scope = ? AND scope_id = ? AND provider IN (${placeholders})`,
    scope.kind,
    scope.id,
    ...providers
  );
  return rows.map(toRecord);
}
