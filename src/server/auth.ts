/**
 * Autonoblog — authentication core (Phase 1).
 *
 * Passwords: bcryptjs (pure JS, no native build). Sessions: server-side rows
 * in the database; the browser only holds an opaque random token (stored
 * hashed in the DB via SHA-256). This module is pure DB + hashing logic —
 * cookie handling lives in auth-context.ts which runs inside request scope.
 *
 * In App Router style this lives server-side only.
 */

import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { get, run, all, nowIso } from "./store";
import { ROLES, type RoleName } from "./roles";

const BCRYPT_ROUNDS = 10;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

export interface PublicUser {
  id: number;
  email: string;
  displayName: string;
  roles: RoleName[];
  createdAt: string;
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): boolean {
  try {
    return bcrypt.compareSync(password, hash);
  } catch {
    return false;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

async function rowToUser(
  row: {
    id: number;
    email: string;
    display_name: string;
    created_at: string;
  } | undefined
): Promise<PublicUser | null> {
  if (!row) return null;
  const roleRows = await all<{ name: RoleName }>(
    `SELECT r.name FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = ?`,
    row.id
  );
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    roles: roleRows.map((r) => r.name),
    createdAt: row.created_at,
  };
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
}

export interface AuthResult {
  user: PublicUser;
  token: string;
  expiresAt: string;
}

/** Create a user with the `contributor` role (least privilege by default). */
export async function registerUser(input: RegisterInput): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error("A valid email address is required.");
  }
  if (input.password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  const displayName = input.displayName.trim() || email.split("@")[0];
  const existing = await get<{ id: number }>(
    "SELECT id FROM users WHERE email = ?",
    email
  );
  if (existing) throw new Error("An account with this email already exists.");

  const now = nowIso();
  const info = await run(
    "INSERT INTO users (email, password_hash, display_name, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    email,
    hashPassword(input.password),
    displayName,
    now,
    now
  );
  // Assign contributor role by default so the account is immediately usable.
  const contributor = await get<{ id: number }>(
    "SELECT id FROM roles WHERE name = 'contributor'"
  );
  if (contributor) {
    await run(
      "INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)",
      info.lastInsertRowid,
      contributor.id
    );
  }
  const user = await rowToUser(
    await get("SELECT * FROM users WHERE id = ?", info.lastInsertRowid)
  );
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await run(
    "INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
    info.lastInsertRowid,
    sha256(token),
    now,
    expiresAt
  );
  return { user: user!, token, expiresAt };
}

/** Verify credentials; returns fresh session on success (throws on failure). */
export async function loginUser(
  email: string,
  password: string
): Promise<AuthResult> {
  const normalized = email.trim().toLowerCase();
  const row = await get<{
    id: number;
    email: string;
    password_hash: string;
    display_name: string;
    created_at: string;
    is_active: number;
  }>("SELECT * FROM users WHERE email = ?", normalized);
  if (!row || !verifyPassword(password, row.password_hash)) {
    throw new Error("Invalid email or password.");
  }
  if (!row.is_active) throw new Error("This account is disabled.");
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await run(
    "INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
    row.id,
    sha256(token),
    nowIso(),
    expiresAt
  );
  return { user: (await rowToUser(row))!, token, expiresAt };
}

/** Look up the user for a session token (validates expiry). Returns null if invalid. */
export async function getUserByToken(
  token: string | undefined | null
): Promise<PublicUser | null> {
  if (!token) return null;
  const row = await get<{
    id: number;
    user_id: number;
    expires_at: string;
  }>("SELECT * FROM sessions WHERE token_hash = ?", sha256(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  const user = await get<{
    id: number;
    email: string;
    password_hash: string;
    display_name: string;
    created_at: string;
    is_active: number;
  }>("SELECT * FROM users WHERE id = ?", row.user_id);
  if (!user || !user.is_active) return null;
  return rowToUser(user);
}

/** Delete a session (logout). */
export async function destroySession(
  token: string | undefined | null
): Promise<void> {
  if (!token) return;
  await run("DELETE FROM sessions WHERE token_hash = ?", sha256(token));
}

// ---- Permissions ----------------------------------------------------------

export async function getRoleIds(userId: number): Promise<number[]> {
  return (
    await all<{ role_id: number }>(
      "SELECT role_id FROM user_roles WHERE user_id = ?",
      userId
    )
  ).map((r) => r.role_id);
}

/**
 * Does the user have `permission`? owner role has a wildcard (all permissions);
 * otherwise checks the role -> permission mapping.
 */
export async function userHasPermission(
  userId: number,
  permission: string
): Promise<boolean> {
  const names = (
    await all<{ name: RoleName }>(
      `SELECT DISTINCT r.name FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = ?`,
      userId
    )
  ).map((r) => r.name);
  if (names.includes("owner")) return true; // owner has every permission
  if (names.length === 0) return false;
  const placeholders = names.map(() => "?").join(",");
  const granted = new Set(
    (
      await all<{ name: string }>(
        `SELECT p.name FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE r.name IN (${placeholders})`,
        ...names
      )
    ).map((x) => x.name)
  );
  return granted.has(permission);
}

export { ROLES };
