/**
 * Autonoblog — plan definitions (limits only; pricing is finalized later).
 *
 * These are the *defaults* seeded into the `plans` table. The database is the
 * source of truth at runtime (the DAL always reads the plan row), so limits can
 * be changed in the DB without a deploy. Pricing is deliberately NOT decided
 * here — every seeded plan is 0 cents until the owner ratifies price points.
 */

/** The limit keys stored in `plans.limits` (JSON). -1 means "unlimited". */
export interface PlanLimits {
  /** Maximum number of blogs a user on this plan may own. */
  max_blogs: number;
  /** AI credits granted per calendar month. */
  ai_credits_per_month: number;
  /** Storage allowance in bytes. */
  storage_bytes: number;
  /** Posts that may be published per calendar month. */
  posts_per_month: number;
  /** Connected social accounts allowed. */
  social_accounts: number;
  /** Installed plugins allowed. */
  plugins: number;
}

export interface PlanSeed {
  key: "free" | "pro" | "plus" | "max";
  name: string;
  monthly_price_cents: number;
  limits: PlanLimits;
}

/**
 * Seeded plans. Only `free` is seeded today because that is the only plan whose
 * limits are actually enforced-ish/ratified; paid tiers will be added to this
 * list (and the `plans` table) once pricing is finalized. Adding a tier later
 * requires no migration: the table is already generic.
 */
export const PLAN_SEEDS: PlanSeed[] = [
  {
    key: "free",
    name: "Free",
    monthly_price_cents: 0,
    limits: {
      max_blogs: 3,
      ai_credits_per_month: 0,
      storage_bytes: 50 * 1024 * 1024, // 50 MB
      posts_per_month: 10,
      social_accounts: 0,
      plugins: 0,
    },
  },
];

/** Look up a seeded plan definition by key. */
export function planSeed(key: string): PlanSeed | undefined {
  return PLAN_SEEDS.find((p) => p.key === key);
}
