/**
 * Autonoblog — secret encryption for integration connections (Phase 6b-prep).
 *
 * Every API key the operator pastes into the Connections screen is stored as an
 * AES-256-GCM blob: `v1.<iv>.<authTag>.<ciphertext>` (base64 parts). The key is
 * either `APP_ENCRYPTION_KEY` (used verbatim as scrypt input material) or, when
 * that is not set, derived once from `DATABASE_URL` with a fixed salt — nothing
 * new is stored either way, so no migration/key-management step is needed.
 *
 * Rules enforced here and by every caller:
 *  - A secret is NEVER returned to the browser; the UI only sees `••••1234`.
 *  - A secret is NEVER logged, never put in an error message and never written
 *    to the repo. `scrub()` removes any secret that a provider might echo back.
 *  - The derived key itself is never printed or persisted.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { cleanUrl } from "../pg";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
/** Fixed salt — the key material (env var or DATABASE_URL) is the secret. */
const SALT = "autonoblog.integration-secrets.v1";
/** What the UI shows for a stored secret: a bullet run + the last 4 characters. */
const MASK = "••••";

export type KeySource = "env" | "database-url" | "none";

let cached: { key: Buffer; source: Exclude<KeySource, "none"> } | null = null;

/** Where the encryption key comes from — shown honestly in the UI. */
export function encryptionKeySource(): KeySource {
  if ((process.env.APP_ENCRYPTION_KEY ?? "").trim()) return "env";
  if (cleanUrl(process.env.DATABASE_URL)) return "database-url";
  return "none";
}

function resolveKey(): { key: Buffer; source: Exclude<KeySource, "none"> } {
  if (cached) return cached;
  const explicit = (process.env.APP_ENCRYPTION_KEY ?? "").trim();
  const material = explicit || cleanUrl(process.env.DATABASE_URL);
  if (!material) {
    throw new Error(
      "Cannot encrypt integration secrets: neither APP_ENCRYPTION_KEY nor DATABASE_URL is set on the server."
    );
  }
  cached = {
    key: scryptSync(material, SALT, 32),
    source: explicit ? "env" : "database-url",
  };
  return cached;
}

/** Encrypt a secret for storage. Returns the `v1.iv.tag.ciphertext` blob. */
export function encryptSecret(plaintext: string): string {
  const { key } = resolveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

/**
 * Decrypt a stored blob. Returns null when the blob is empty, malformed, or was
 * written with a different key — callers must treat that as "no usable secret"
 * rather than guessing.
 */
export function decryptSecret(blob: string): string | null {
  if (!blob) return null;
  try {
    const parts = blob.split(".");
    if (parts.length !== 4 || parts[0] !== VERSION) return null;
    const [, ivB64, tagB64, ciphertextB64] = parts;
    const decipher = createDecipheriv(
      ALGORITHM,
      resolveKey().key,
      Buffer.from(ivB64, "base64")
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return plaintext;
  } catch {
    return null;
  }
}

/** The only representation of a secret the browser ever sees: `••••1234`. */
export function secretHint(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= 4) return MASK;
  return `${MASK}${trimmed.slice(-4)}`;
}

/** Remove every occurrence of a secret from a string that may be shown/logged. */
export function scrub(text: string, secret?: string | null): string {
  let out = text;
  if (secret && secret.length >= 4) {
    out = out.split(secret).join(MASK);
  }
  return out;
}
