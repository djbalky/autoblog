/**
 * Autonoblog — seed data (roles, permissions, default owner account).
 *
 * Idempotent: safe to call on every boot. Inserts default rows only when the
 * target is missing, never overwrites. Runs against whichever backend the
 * store selects (Postgres when DATABASE_URL is set, else SQLite).
 */
import { nowIso, run, get } from "./store";
import { hashPassword } from "./auth";
import { ROLES, ROLE_PERMISSIONS, ALL_PERMISSIONS, type RoleName } from "./roles";
import { PLAN_SEEDS } from "./plans";
export type { RoleName };
export { ROLES };
export const DEFAULT_ADMIN_EMAIL =
  process.env.AUTONOBLOG_ADMIN_EMAIL ?? "admin@autonoblog.local";
export const DEFAULT_ADMIN_PASSWORD =
  process.env.AUTONOBLOG_ADMIN_PASSWORD ?? "autonoblog-admin";
export const DEFAULT_ADMIN_NAME =
  process.env.AUTONOBLOG_ADMIN_NAME ?? "Site Owner";
/** Ensure roles, permissions and the owner/admin account exist. */
export async function seed(): Promise<void> {
  const now = nowIso();
  // 1. Permissions
  for (const perm of ALL_PERMISSIONS) {
    await run(
      "INSERT OR IGNORE INTO permissions (name, description) VALUES (?, ?)",
      perm,
      ""
    );
  }
  // 2. Roles + role_permissions
  for (const role of ROLES) {
    await run(
      "INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?)",
      role,
      ""
    );
  }
  for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
    for (const perm of perms) {
      const rows = await get<{ id: number }>(
        "SELECT id FROM roles WHERE name = ?",
        role
      );
      if (!rows) continue;
      if (perm === "*") continue; // owner's wildcard handled in lookup
      const p = await get<{ id: number }>(
        "SELECT id FROM permissions WHERE name = ?",
        perm
      );
      if (!p) continue;
      await run(
        "INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)",
        rows.id,
        p.id
      );
    }
  }
  // 4. Plans (billing/usage foundation). INSERT OR IGNORE: an existing plan row
  // is never overwritten, so operator edits in the DB survive every boot.
  for (const plan of PLAN_SEEDS) {
    await run(
      "INSERT OR IGNORE INTO plans (key, name, monthly_price_cents, limits, active, created_at) VALUES (?, ?, ?, ?, 1, ?)",
      plan.key,
      plan.name,
      plan.monthly_price_cents,
      JSON.stringify(plan.limits),
      now
    );
  }
  // 5. Default owner account (idempotent; only when none exists yet)
  const existing = await get<{ id: number }>(
    "SELECT id FROM users WHERE email = ?",
    DEFAULT_ADMIN_EMAIL
  );
  if (!existing) {
    const info = await run(
      "INSERT INTO users (email, password_hash, display_name, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
      DEFAULT_ADMIN_EMAIL,
      hashPassword(DEFAULT_ADMIN_PASSWORD),
      DEFAULT_ADMIN_NAME,
      now,
      now
    );
    const ownerRole = await get<{ id: number }>(
      "SELECT id FROM roles WHERE name = 'owner'"
    );
    if (ownerRole) {
      await run(
        "INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)",
        info.lastInsertRowid,
        ownerRole.id
      );
    }
  }
}
